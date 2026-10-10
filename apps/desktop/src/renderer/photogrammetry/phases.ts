/**
 * One run, one progress view: matching the photos and building the maps are two jobs underneath
 * (`photo.align`, then `photo.products`), shown as one list of phases in plain words. The detailed
 * stages of the job at work stay available below it.
 */
import type { JobRecord, JobStep, PhotoProduct, PhotoRun } from '@aio/schema';
import { isActive } from '../jobs';

/** A run's status in plain words (the runs list and the run's header). */
export const RUN_STATUS: Readonly<Record<PhotoRun['status'], string>> = {
  aligning: 'Matching photos',
  aligned: 'Photos matched',
  adjusted: 'Adjusted with ground control',
  processing: 'Building the maps',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export type PhaseId = 'read' | 'match' | 'control' | 'map' | 'model' | 'add';
/** `kept`: every stage of the phase was kept from before a pause; `stopped`: paused or cancelled. */
export type PhaseState = 'pending' | 'running' | 'done' | 'kept' | 'stopped' | 'failed';

export interface RunPhase {
  id: PhaseId;
  label: string;
  state: PhaseState;
}

export const PHASE_LABEL: Readonly<Record<PhaseId, string>> = {
  read: 'Reading photos',
  match: 'Matching photos',
  control: 'Improving accuracy with ground control',
  map: 'Building the map',
  model: 'Building the 3D model',
  add: 'Adding to the project',
};

const ORDER: readonly PhaseId[] = ['read', 'match', 'control', 'map', 'model', 'add'];

/** The phase each stage of the photo pipelines belongs to; a stage not listed joins its job's. */
const PHASE_OF_STAGE: Readonly<Record<string, PhaseId>> = {
  inspect: 'read',
  features: 'match',
  match: 'match',
  sfm: 'match',
  georef: 'match',
  report: 'match',
  adjust: 'control',
  prepare: 'map',
  dense: 'map',
  fuse: 'map',
  cloud: 'map',
  dsm: 'map',
  dtm: 'map',
  ortho: 'map',
  mesh: 'model',
  texture: 'model',
  tiles: 'model',
  commit: 'add',
};

const JOB_PHASE: Readonly<Partial<Record<JobRecord['pipeline'], PhaseId>>> = {
  'photo.align': 'match',
  'photo.georef': 'control',
  'photo.products': 'map',
};

/** One phase's state from the stages in it and whether their job is still at work. */
export function phaseState(steps: readonly Pick<JobStep, 'state'>[], active: boolean): PhaseState {
  if (!steps.length) return 'pending';
  const has = (s: JobStep['state']) => steps.some((x) => x.state === s);
  if (has('failed')) return 'failed';
  if (has('running')) return 'running';
  if (steps.every((x) => x.state === 'skipped')) return 'kept';
  if (steps.every((x) => x.state === 'done' || x.state === 'skipped')) return 'done';
  if (has('cancelled')) return 'stopped';
  if (steps.every((x) => x.state === 'pending')) return 'pending';
  // some stages done, the next not started yet
  return active ? 'running' : 'stopped';
}

function phasesOfJob(job: JobRecord): RunPhase[] {
  const fallback = JOB_PHASE[job.pipeline] ?? 'match';
  // every stage of the ground control adjustment is one phase (its report and save included)
  const of = (name: string): PhaseId =>
    job.pipeline === 'photo.georef' ? 'control' : (PHASE_OF_STAGE[name] ?? fallback);
  const active = isActive(job);
  return ORDER.filter((id) => job.steps.some((s) => of(s.name) === id)).map((id) => ({
    id,
    label: PHASE_LABEL[id],
    state: phaseState(
      job.steps.filter((s) => of(s.name) === id),
      active,
    ),
  }));
}

/** The phases the outputs a person asked for will run through, before their job exists. */
export function plannedPhases(products: readonly PhotoProduct[]): PhaseId[] {
  if (!products.length) return [];
  const model = products.includes('mesh') || products.includes('tiles');
  return ['map', ...(model ? (['model'] as const) : []), 'add'];
}

export interface RunView {
  /** The job at work (or the last one): pause, cancel and resume act on it. */
  job: JobRecord | null;
  phases: RunPhase[];
  /** 0 to 100 over the whole run. */
  percent: number;
  /** The phase at work, or the next one, in words; null when nothing is left to do. */
  headline: string | null;
  /** Matching finished and the maps are about to start by themselves. */
  between: boolean;
}

/** Share of a whole run spent matching; the rest builds the maps. */
const MATCH_SHARE = 0.3;

/**
 * The run as one list of phases. `jobs` are the run's jobs, newest first; `queued` the outputs
 * that start by themselves when matching finishes (null when none are waiting).
 */
export function runView(
  jobs: readonly JobRecord[],
  queued: readonly PhotoProduct[] | null,
): RunView {
  const job = jobs[0] ?? null;
  if (!job) return { job, phases: [], percent: 0, headline: null, between: false };
  if (job.pipeline === 'photo.georef') {
    const phases = phasesOfJob(job);
    return {
      job,
      phases,
      percent: Math.round(job.progress * 100),
      headline: headlineOf(phases),
      between: false,
    };
  }
  const align = jobs.find((j) => j.pipeline === 'photo.align') ?? null;
  const made = jobs.find((j) => j.pipeline === 'photo.products') ?? null;
  // maps made before the photos were matched again belong to an earlier pass
  const products = made && (!align || made.createdAt >= align.createdAt) ? made : null;
  const phases = [...(align ? phasesOfJob(align) : []), ...(products ? phasesOfJob(products) : [])];
  const planned = !products && queued ? plannedPhases(queued) : [];
  for (const id of planned) phases.push({ id, label: PHASE_LABEL[id], state: 'pending' });
  const second = products !== null || planned.length > 0;
  const fraction =
    align && second
      ? align.progress * MATCH_SHARE + (products?.progress ?? 0) * (1 - MATCH_SHARE)
      : (products ?? align ?? job).progress;
  return {
    job,
    phases,
    percent: Math.round(fraction * 100),
    headline: headlineOf(phases),
    between: planned.length > 0 && align?.status === 'done',
  };
}

function headlineOf(phases: readonly RunPhase[]): string | null {
  const at =
    phases.find((p) => p.state === 'running') ??
    phases.find((p) => p.state !== 'done' && p.state !== 'kept');
  return at?.label ?? null;
}
