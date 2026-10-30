/**
 * The checks after a new survey date (intelligence review I1, study item 5.1): when a
 * `survey.prepare` job on the open project ends done, however it was started, each date it
 * prepared that has an earlier date gets, quietly and one step at a time:
 *
 * 1. the site-level survey QA (`survey.qa` against the nearest earlier survey with a prepared
 *    surface, at the site's QA level, without checkpoints: a processing run's GCPs built the
 *    surface, so they are not independent checks), a quiet job listed in Jobs with Cancel; a failed
 *    check holds the survey as a hand run does, and at level Off it measures the change without a
 *    verdict;
 * 2. the in-app change compute for the pair (previous date, new date), shown in the Changes panel
 *    with its Cancel; its verdicts stay proposals.
 *
 * So a new date brings its QA verdict and a "what changed" set without a click. Nothing else is
 * written. Never repeated: a date whose QA file is newer than its surface gets no QA, a pair with
 * a change set newer than the new date's surface no compute, and each step is tried once per
 * open; a date prepared again (its surface replaced) is checked again. Never on a project with
 * one date, nor for its earliest date. Light on a computer the person is using: it settles first,
 * waits until no job is at work on the project and the QA and Changes panels are idle, and a step
 * the person cancels stops the chain until the project is opened again. Nothing starts with the
 * setting off (`Settings.autoCheckNewDates`, absent means on) or for a read-only project; the QA
 * step needs the pipeline Python.
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

/** `a` was written at or after `b` (ISO times; an unreadable one counts as older). */
const notOlder = (a: string, b: string): boolean => {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(tb)) return true;
  return !Number.isNaN(ta) && ta >= tb;
};

/**
 * What to run for the newly prepared dates `fresh`, in date order (pure). `checked`: the QA files
 * (date and when checked); `pairs`: the change sets (pair and when made); `tried`: step keys tried
 * this open; `qa`: whether a QA job may run (the pipeline Python is there). A QA file or change set
 * older than the new date's surface is out of date: the date was prepared again.
 */
export function newDateSteps(x: {
  captures: readonly { id: string; date: string }[];
  fresh: ReadonlySet<string>;
  surfaces: readonly HeightTiles[];
  checked: readonly { capture: string; checkedAt: string }[];
  pairs: readonly { from: string; to: string; createdAt: string }[];
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
    const madeAt = surface.preparedAt;
    // the nearest earlier survey with a prepared surface (as the QA panel's own run picks)
    const before = dated
      .slice(0, i)
      .reverse()
      .map((d) => ({ id: d.id, s: surfaceOf(x.surfaces, d.id) }))
      .find((d) => d.s !== null);
    // without an earlier surface (and no checkpoints) the check could only say unchecked
    const qaDone = x.checked.some((q) => q.capture === c.id && notOlder(q.checkedAt, madeAt));
    if (x.qa && before?.s && !qaDone) {
      const step: NewDateStep = {
        kind: 'qa',
        capture: c.id,
        surface: surface.id,
        previous: { capture: before.id, surface: before.s.id },
      };
      if (!x.tried.has(stepKey(step))) steps.push(step);
    }
    const pairDone = x.pairs.some(
      (p) => p.from === prev.id && p.to === c.id && notOlder(p.createdAt, madeAt),
    );
    if (!pairDone) {
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
  /** The QA files of the project (date, when checked), or null when they cannot be read. */
  readChecked(projectId: string): Promise<{ capture: string; checkedAt: string }[] | null>;
  /** The change sets of the project (pair, when made), or null when they cannot be read. */
  readPairs(projectId: string): Promise<{ from: string; to: string; createdAt: string }[] | null>;
  /** The site's QA level (`survey/settings.json`). */
  qaLevel(projectId: string): Promise<QaLevel>;
  /** Start the QA job quietly (`jobs.startQuiet`). */
  startQa(req: {
    pipeline: 'survey.qa';
    project: string;
    params: SurveyQaParams;
  }): Promise<{ jobId: string } | { error: string }>;
  /**
   * Compute the in-app change sets of a pair; how it ended, or null when it did not start (a
   * person's compute was running).
   */
  computeChange(
    projectId: string,
    pair: { from: string; to: string },
  ): Promise<'done' | 'failed' | 'cancelled' | null>;
  /** Cancel the chain's compute of `pair` if it is still running (on stop). */
  cancelChange?(pair: { from: string; to: string }): void;
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
  const state = { running: false, again: false, stopped: false, marked: false };
  /** What is remembered for the open project, until it closes. */
  let open: { id: string; fresh: Set<string>; tried: Set<string>; cancelled: boolean } | null =
    null;
  /** Waits for a job's end that must give up when the project closes or the watch stops. */
  const pending = new Set<() => void>();
  /** The pair the chain is computing now. */
  let computing: { from: string; to: string } | null = null;
  const current = () => deps.workspace.getState().project;
  const giveUp = () => {
    for (const f of [...pending]) f();
  };

  /** The job's record once it has ended; null when it leaves the list or the wait is given up. */
  const jobEnded = (id: string): Promise<JobRecord | null> =>
    new Promise((resolve) => {
      let stop = (): void => undefined;
      const done = (j: JobRecord | null) => {
        stop();
        pending.delete(cancel);
        resolve(j);
      };
      const cancel = () => {
        done(null);
      };
      const look = (list: readonly JobRecord[]): 'wait' | JobRecord | null => {
        const j = list.find((x) => x.id === id);
        if (!j) return null;
        return ENDED.has(j.status) ? j : 'wait';
      };
      const now = look(deps.jobs.getState().jobs);
      if (now !== 'wait') {
        resolve(now);
        return;
      }
      pending.add(cancel);
      stop = deps.jobs.subscribe((s) => {
        const j = look(s.jobs);
        if (j !== 'wait') done(j);
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
      checked,
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
    state.marked = true;
    if (step.kind === 'qa') {
      const r = await deps.startQa({
        pipeline: 'survey.qa',
        project: now.root,
        params: {
          capture: step.capture,
          surface: step.surface,
          level,
          previous: step.previous,
        },
      });
      if ('jobId' in r) {
        const job = await jobEnded(r.jobId);
        if (job?.status === 'cancelled') mine.cancelled = true;
      }
    } else {
      const pair = { from: step.from, to: step.to };
      computing = pair;
      let how: Awaited<ReturnType<NewDatesWatchDeps['computeChange']>>;
      try {
        how = await deps.computeChange(mine.id, pair);
      } finally {
        computing = null;
      }
      if (how === 'cancelled') mine.cancelled = true;
      // a person's compute was running: not tried, looked at again once it is idle
      if (how === null) mine.tried.delete(stepKey(step));
    }
    if (!still()) return;
    await deps.refresh(mine.id);
    // the next step, if any, runs on the next turn of the loop
    state.again = true;
  };

  // a change while a check runs (or a step just run) asks for one more check after it
  const more = (): boolean => state.again && !state.stopped;
  // whether the check that just ran marked a step as tried (set inside check)
  const stepMarked = (): boolean => state.marked;

  const run = async (): Promise<void> => {
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    try {
      do {
        state.again = false;
        state.marked = false;
        try {
          await check();
        } catch (e) {
          // a step that failed stays tried (it was marked before it ran) and the next one is
          // looked at; a failure before any step waits for the next prepare job
          console.warn('The checks after a new survey date failed', e);
          if (stepMarked()) state.again = true;
        }
      } while (more());
    } finally {
      state.running = false;
    }
  };

  const unWorkspace = deps.workspace.subscribe((s, prev) => {
    if (s.project?.id === prev.project?.id) return;
    // the project closed or switched: the chain's compute in flight is of no use any more
    if (computing) deps.cancelChange?.(computing);
    giveUp();
    open = s.project
      ? { id: s.project.id, fresh: new Set(), tried: new Set(), cancelled: false }
      : null;
  });

  // a prepare job on the open project ended done: its dates are new candidates, tried afresh
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
        open.tried.delete(`qa:${c}`);
        for (const k of [...open.tried]) if (k.endsWith(`>${c}`)) open.tried.delete(k);
        added = true;
      }
    }
    if (added) void run();
  });

  const first = current();
  if (first) open = { id: first.id, fresh: new Set(), tried: new Set(), cancelled: false };
  return () => {
    state.stopped = true;
    if (computing) deps.cancelChange?.(computing);
    giveUp();
    unWorkspace();
    unJobs();
  };
}
