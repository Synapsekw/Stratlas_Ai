/**
 * The checks after a new survey date (intelligence review I1, study item 5.1): when a
 * `survey.prepare` job on the open project ends done, however it was started, each date it
 * prepared that has an earlier date gets, quietly and one step at a time:
 *
 * 1. the site-level survey QA (`survey.qa` against the previous survey, at the site's QA level, as
 *    the QA panel's own run), a quiet job listed in Jobs with Cancel; a failed check holds the
 *    survey as a hand run does, and at level Off it measures the change without a verdict;
 * 2. the in-app change compute for the pair (previous date, new date), shown in the Changes panel
 *    with its Cancel; its verdicts stay proposals.
 *
 * So a new date brings its QA verdict and a "what changed" set without a click. Nothing else is
 * written. Never repeated: a date with a QA file gets no QA, a pair with a change set no compute,
 * and each step is tried once per open. Never on a project with one date, nor for its earliest
 * date. Light on a computer the person is using: it settles first, waits until no job is at work
 * on the project and the QA and Changes panels are idle, and a step the person cancels stops the
 * chain until the project is opened again. Nothing starts with the setting off
 * (`Settings.autoCheckNewDates`, absent means on) or for a read-only project; the QA step needs the
 * pipeline Python.
 */
import type { HeightTiles, JobRecord, QaLevel, SurveyQaParams } from '@aio/schema';
import type { Workspace } from '@aio/workspace';
import type { StoreApi } from 'zustand/vanilla';
import { isActive, sameFolder } from '../jobs';

/** One step of the chain. */
export type NewDateStep =
  | {
      kind: 'qa';
      capture: string;
      surface: string;
      previous: { capture: string; surface: string };
    }
  | { kind: 'change'; from: string; to: string };

/** The key a step is remembered by within one open. */
export const stepKey = (s: NewDateStep): string =>
  s.kind === 'qa' ? `qa:${s.capture}` : `change:${s.from}>${s.to}`;

const RANK: Record<string, number> = { dsm: 1, cloud: 2, dtm: 3 };

/** A survey's own prepared surface (DSM first, then a cloud, then a DTM), as the QA panel picks. */
function surfaceOf(surfaces: readonly HeightTiles[], capture: string): HeightTiles | null {
  let best: HeightTiles | null = null;
  for (const s of surfaces) {
    if (s.capture !== capture) continue;
    const r = RANK[s.source.kind] ?? 9;
    const b = best ? (RANK[best.source.kind] ?? 9) : 99;
    if (!best || r < b || (r === b && s.id < best.id)) best = s;
  }
  return best;
}

/**
 * What to run for the newly prepared dates `fresh`, in date order (pure). `checked`: the dates
 * with a QA file; `pairs`: the date pairs with a change set; `tried`: step keys tried this open;
 * `qa`: whether a QA job may run (the pipeline Python is there).
 */
export function newDateSteps(x: {
  captures: readonly { id: string; date: string }[];
  fresh: ReadonlySet<string>;
  surfaces: readonly HeightTiles[];
  checked: ReadonlySet<string>;
  pairs: readonly { from: string; to: string }[];
  tried: ReadonlySet<string>;
  qa: boolean;
}): NewDateStep[] {
  if (x.captures.length < 2) return [];
  const dated = [...x.captures].sort(
    (a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : 1),
  );
  const steps: NewDateStep[] = [];
  dated.forEach((c, i) => {
    const prev = dated[i - 1];
    if (!prev || !x.fresh.has(c.id)) return;
    const surface = surfaceOf(x.surfaces, c.id);
    if (!surface) return;
    const before = surfaceOf(x.surfaces, prev.id);
    // without the previous survey's surface (and no checkpoints) the check could only say unchecked
    if (x.qa && before && !x.checked.has(c.id)) {
      const step: NewDateStep = {
        kind: 'qa',
        capture: c.id,
        surface: surface.id,
        previous: { capture: prev.id, surface: before.id },
      };
      if (!x.tried.has(stepKey(step))) steps.push(step);
    }
    if (!x.pairs.some((p) => p.from === prev.id && p.to === c.id)) {
      const step: NewDateStep = { kind: 'change', from: prev.id, to: c.id };
      if (!x.tried.has(stepKey(step))) steps.push(step);
    }
  });
  return steps;
}

/** Time to let the prepare job's end settle (the stores read again) before a step, ms. */
const SETTLE_MS = 2000;
/** How often to look again while the project is busy, ms. */
const IDLE_POLL_MS = 2000;

export interface NewDatesWatchDeps {
  workspace: StoreApi<Workspace>;
  jobs: StoreApi<{ jobs: JobRecord[] }>;
  /** `Settings.autoCheckNewDates` (absent means on), and the run allows it. */
  setting(): boolean;
  /** The open project may be written (not a package, not read-only). */
  writable(): boolean;
  /** The pipeline Python is installed. */
  hasPython(): boolean;
  /** The QA panel or the Changes panel is at work (a person's run): wait for it. */
  busy(): boolean;
  readSurfaces(projectId: string): Promise<HeightTiles[] | null>;
  /** The dates of the project with a QA file, or null when they cannot be read. */
  readChecked(projectId: string): Promise<string[] | null>;
  /** The date pairs with a change set, or null when they cannot be read. */
  readPairs(projectId: string): Promise<{ from: string; to: string }[] | null>;
  /** The site's QA level (`survey/settings.json`). */
  qaLevel(projectId: string): Promise<QaLevel>;
  /** Start the QA job quietly (`jobs.startQuiet`). */
  startQa(req: {
    pipeline: 'survey.qa';
    project: string;
    params: SurveyQaParams;
  }): Promise<{ jobId: string } | { error: string }>;
  /** Compute the in-app change sets of a pair; how it ended. */
  computeChange(
    projectId: string,
    pair: { from: string; to: string },
  ): Promise<'done' | 'failed' | 'cancelled'>;
  /** Read the QA and change stores again. */
  refresh(projectId: string): Promise<void> | void;
  /** Wait `ms` (tests pass one that does not). */
  wait?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const ENDED: ReadonlySet<JobRecord['status']> = new Set([
  'done',
  'failed',
  'cancelled',
  'interrupted',
]);

/** The captures a prepare job's parameters name. */
function capturesOf(job: JobRecord): string[] {
  const surfaces = (job.params as { surfaces?: unknown }).surfaces;
  if (!Array.isArray(surfaces)) return [];
  return surfaces.flatMap((s) => {
    const c = (s as { capture?: unknown } | null)?.capture;
    return typeof c === 'string' ? [c] : [];
  });
}

/** Start the checks after a new date; returns the stop. Called once at start. */
export function connectNewDatesWatch(deps: NewDatesWatchDeps): () => void {
  const wait = deps.wait ?? sleep;
  const state = { running: false, again: false, stopped: false };
  /** What is remembered for the open project, until it closes. */
  let open: { id: string; fresh: Set<string>; tried: Set<string>; cancelled: boolean } | null =
    null;
  const current = () => deps.workspace.getState().project;

  const jobEnded = (id: string): Promise<JobRecord | null> =>
    new Promise((resolve) => {
      const look = (list: readonly JobRecord[]) => {
        const j = list.find((x) => x.id === id);
        return j && ENDED.has(j.status) ? j : null;
      };
      const now = look(deps.jobs.getState().jobs);
      if (now) {
        resolve(now);
        return;
      }
      const stop = deps.jobs.subscribe((s) => {
        const j = look(s.jobs);
        if (!j && !state.stopped) return;
        stop();
        resolve(j);
      });
    });

  const check = async (): Promise<void> => {
    const project = current();
    if (state.stopped || !project || open?.id !== project.id) return;
    const mine = open;
    const still = () => !state.stopped && current()?.id === mine.id && open === mine;
    const allowed = () => deps.setting() && deps.writable() && !mine.cancelled;
    if (mine.fresh.size === 0) return;
    if (!allowed()) {
      mine.fresh.clear();
      return;
    }
    await wait(SETTLE_MS);
    for (;;) {
      if (!still()) return;
      if (!allowed()) {
        mine.fresh.clear();
        return;
      }
      const root = current()?.root ?? '';
      const busy =
        deps.busy() ||
        deps.jobs.getState().jobs.some((j) => isActive(j) && sameFolder(j.project, root));
      if (!busy) break;
      await wait(IDLE_POLL_MS);
    }
    const [surfaces, checked, pairs, level] = await Promise.all([
      deps.readSurfaces(mine.id),
      deps.readChecked(mine.id),
      deps.readPairs(mine.id),
      deps.qaLevel(mine.id).catch((): QaLevel => 'off'),
    ]);
    if (!still()) return;
    const now = current();
    if (!now || !surfaces || !checked || !pairs) return;
    const steps = newDateSteps({
      captures: now.manifest.captures,
      fresh: mine.fresh,
      surfaces,
      checked: new Set(checked),
      pairs,
      tried: mine.tried,
      qa: deps.hasPython(),
    });
    const step = steps[0];
    if (!step) {
      mine.fresh.clear();
      return;
    }
    mine.tried.add(stepKey(step));
    if (step.kind === 'qa') {
      let r: { jobId: string } | { error: string };
      try {
        r = await deps.startQa({
          pipeline: 'survey.qa',
          project: now.root,
          params: {
            capture: step.capture,
            surface: step.surface,
            level,
            previous: step.previous,
          },
        });
      } catch (e) {
        r = { error: e instanceof Error ? e.message : String(e) };
      }
      if ('jobId' in r) {
        const job = await jobEnded(r.jobId);
        if (job?.status === 'cancelled') mine.cancelled = true;
      }
    } else {
      const how = await deps.computeChange(mine.id, { from: step.from, to: step.to });
      if (how === 'cancelled') mine.cancelled = true;
    }
    if (!still()) return;
    await deps.refresh(mine.id);
    // the next step, if any, runs on the next turn of the loop
    state.again = true;
  };

  // a change while a check runs (or a step just run) asks for one more check after it
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
    if (s.project?.id === prev.project?.id) return;
    open = s.project
      ? { id: s.project.id, fresh: new Set(), tried: new Set(), cancelled: false }
      : null;
  });

  // a prepare job on the open project ended done: its dates are new candidates
  const unJobs = deps.jobs.subscribe((s, prev) => {
    const project = current();
    if (!project || !open) return;
    let added = false;
    for (const j of s.jobs) {
      if (j.pipeline !== 'survey.prepare' || j.status !== 'done') continue;
      if (!sameFolder(j.project, project.root)) continue;
      const before = prev.jobs.find((p) => p.id === j.id);
      if (!before || !isActive(before)) continue;
      for (const c of capturesOf(j)) {
        open.fresh.add(c);
        added = true;
      }
    }
    if (added) void run();
  });

  const first = current();
  if (first) open = { id: first.id, fresh: new Set(), tried: new Set(), cancelled: false };
  return () => {
    state.stopped = true;
    unWorkspace();
    unJobs();
  };
}
