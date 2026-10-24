/**
 * The one Ask AI run at a time, on the backend `resolveBackend` chose, with today's detection
 * code underneath: the cloud runner (`ai:detect` in batches), the local model (`inference:run`)
 * or the local detectors (`detect.vlm` jobs, one per photo layer). Whatever arrives stays: a run
 * that fails or is stopped keeps its suggestions and lists the items left, which Try again sends
 * on the same backend. Stop ends the strip at once (never left "checking"). A run belongs to its
 * project: opening another project stops and clears it, and nothing that arrives late from it is
 * added to the review. A cloud run never starts without the person's yes (`confirmed`, or the
 * project's "Don't ask again").
 */
import { aiPassName } from '@aio/annotate/detections';
import type { IpcEvent, ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { promptTaxonomy, toDraftDetections, type DetectItem } from '../../detections/convert';
import {
  newRunId,
  planRuns,
  runRequest,
  type Chosen,
  type PlannedRun,
} from '../../detections/detectors/runPlan';
import { prepareItem } from '../../detections/prepare';
import { startDetectRun } from '../../detections/runner';
import { detections, dispatch, loadDetections, noteAssessed } from '../../detections/store';
import { isActive } from '../../jobs';
import { bridge, jobs } from '../../shell';
import { cloudHint, type ResolvedBackend } from './backend';
import type { AskCheck } from './checks';
import { classMapFor, writeClassMap } from './classMap';
import { cloudConfirmSkipped, rememberCheck, type AskAiPrefs } from './prefs';

export interface AskRun {
  runIds: string[];
  projectId: string;
  backend: 'detectors' | 'local' | 'cloud';
  /** What was looked at, as the strip says it ("All photos"). */
  what: string;
  /** The run looks at video frames, so the strip counts frames. */
  frames: boolean;
  total: number;
  done: number;
  found: number;
  phase: 'queued' | 'running' | 'done' | 'stopped' | 'failed';
  error?: string;
  /** Items not looked at (after a stop or a failure); Try again sends them. */
  remaining: DetectItem[];
}

export interface AskRunInput {
  projectId: string;
  projectRoot: string;
  manifest: ProjectManifest;
  items: readonly DetectItem[];
  check: AskCheck;
  what: string;
  backend: Exclude<ResolvedBackend, { kind: 'none' }>;
  prefs: AskAiPrefs;
  /** The person said yes to the cloud confirm. A cloud run without it (or "Don't ask again") throws. */
  confirmed?: boolean;
}

export const askAiRun: StoreApi<{ run: AskRun | null }> = createStore<{ run: AskRun | null }>(
  () => ({ run: null }),
);

export function useAskAiRun<T>(sel: (s: { run: AskRun | null }) => T): T {
  return useStore(askAiRun, sel);
}

/** The run in hand: what started it, and how to stop it. */
interface Active {
  token: number;
  input: AskRunInput;
  stop: () => void;
  /** A local run continues under its own id (the model skips what it already read). */
  localRunId?: string;
}

let active: Active | null = null;
let seq = 0;

const isLive = (token: number) => active?.token === token;
const busy = (r: AskRun | null) => r?.phase === 'running' || r?.phase === 'queued';

/** Change the run, unless it is no longer the one in hand. */
function patch(token: number, f: (r: AskRun) => Partial<AskRun>): void {
  if (!isLive(token)) return;
  const run = askAiRun.getState().run;
  if (run) askAiRun.setState({ run: { ...run, ...f(run) } });
}

/** A run id that sorts by time (`20261024-120000-ab12cd`). */
function runStamp(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  return `${stamp}-${globalThis.crypto.randomUUID().slice(0, 6)}`;
}

const classesOf = (m: ProjectManifest) => m.classCatalogues.flatMap((c) => c.classes);

export async function startAskRun(i: AskRunInput): Promise<void> {
  if (i.backend.kind === 'cloud' && i.confirmed !== true && !cloudConfirmSkipped(i.projectId))
    throw new Error('A cloud run starts only once the person has confirmed what is sent.');
  if (busy(askAiRun.getState().run)) return;
  rememberCheck(i.projectId, i.check);
  await begin(i);
}

async function begin(i: AskRunInput, localRunId?: string): Promise<void> {
  const token = ++seq;
  active = { token, input: i, stop: () => undefined };
  askAiRun.setState({
    run: {
      runIds: [],
      projectId: i.projectId,
      backend: i.backend.kind,
      what: i.what,
      frames: i.items.some((x) => x.kind === 'frame'),
      total: i.items.length,
      done: 0,
      found: 0,
      phase: 'running',
      remaining: [],
    },
  });
  const b = i.backend;
  if (b.kind === 'cloud') await runCloud(token, i);
  else if (b.kind === 'local') await runLocal(token, i, b.model, localRunId);
  else await runDetectors(token, i, b.chosen);
}

async function runCloud(token: number, i: AskRunInput): Promise<void> {
  const { projectId, manifest, items } = i;
  const runId = runStamp();
  const pass = aiPassName(runId);
  const taxonomy = promptTaxonomy(manifest.severityModels, manifest.classCatalogues);
  noteAssessed(
    pass,
    items.flatMap((x) => (x.kind === 'photo' ? [x.photo] : [])),
  );
  patch(token, () => ({ runIds: [runId] }));
  const runner = startDetectRun(
    {
      runId,
      pass,
      projectId,
      items,
      classes: taxonomy.classes,
      severity: taxonomy.severity,
      hint: cloudHint(i.check, taxonomy.classes),
      batchSize: i.prefs.cloudBatch,
    },
    {
      detect: async (req) => {
        const r = await bridge.call('ai:detect', req);
        return r.ok ? r.value : { ok: false, error: r.error };
      },
      cancel: (id) => {
        void bridge.call('ai:cancel', { runId: id });
      },
      prepare: (item) => prepareItem(projectId, manifest.layers, item),
      convert: (res, byKey, sizes) =>
        toDraftDetections({
          results: res.results,
          items: byKey,
          sizes,
          models: manifest.severityModels,
          catalogues: manifest.classCatalogues,
          provider: res.provider,
          model: res.model,
          promptVersion: res.promptVersion,
          runId,
          pass,
          now: new Date().toISOString(),
          existing: detections.getState().review.detections,
          newId: () => globalThis.crypto.randomUUID(),
        }),
      add: (list, run) => {
        // a run of a project no longer open adds nothing
        if (!isLive(token)) return;
        dispatch({
          type: 'add',
          detections: list,
          label: t('det.ai.undoLabel'),
          ...(run ? { run } : {}),
        });
      },
      progress: (p) => {
        patch(token, (r) => {
          // stopped stays stopped while the batch in flight still answers
          const held = r.phase === 'stopped' && p.phase === 'running';
          return {
            done: p.imagesDone,
            total: p.images,
            found: p.found,
            phase: held ? 'stopped' : p.phase,
            ...(p.error !== undefined ? { error: p.error } : {}),
            remaining: held ? items.slice(p.imagesDone) : p.phase === 'running' ? [] : p.remaining,
          };
        });
      },
      now: () => new Date().toISOString(),
    },
  );
  if (active?.token === token)
    active.stop = () => {
      runner.stop();
      patch(token, (r) => ({ phase: 'stopped', remaining: items.slice(r.done) }));
    };
  await runner.done;
}

async function runLocal(
  token: number,
  i: AskRunInput,
  model: Extract<ResolvedBackend, { kind: 'local' }>['model'],
  resumeId?: string,
): Promise<void> {
  const { projectId, items, prefs } = i;
  const classMap = classMapFor(projectId, model, classesOf(i.manifest));
  writeClassMap(projectId, model.id, classMap);
  const runId = resumeId ?? runStamp();
  if (active?.token === token) active.localRunId = runId;
  patch(token, () => ({ runIds: [runId] }));
  const conf = prefs.minConfidence ?? model.card.minConfidence ?? 0.25;
  const size = prefs.tile.size ?? model.card.input.width;
  const overlap = prefs.tile.overlap ?? Math.round(size / 5);
  let skipped = 0;
  /** Items not read yet, and (unless the run failed) items read but not readable. */
  const rest = (r: AskRun, failed: boolean) => {
    const n = Math.min(items.length, Math.max(0, r.total - r.done + (failed ? 0 : skipped)));
    return n === 0 ? [] : items.slice(items.length - n);
  };
  const off = window.aio.on('inference:progress', (e: IpcEvent<'inference:progress'>) => {
    if (e.runId !== runId) return;
    skipped = e.skipped ?? skipped;
    patch(token, () => ({ done: e.done, total: e.total, found: e.found }));
  });
  if (active?.token === token)
    active.stop = () => {
      void bridge.call('inference:cancel', { runId });
      patch(token, (r) => ({ phase: 'stopped', remaining: rest(r, false) }));
    };
  let res: Awaited<ReturnType<typeof bridge.call<'inference:run'>>>;
  try {
    res = await bridge.call('inference:run', {
      runId,
      projectId,
      model: model.id,
      items: items.map((x) =>
        x.kind === 'photo' ? { layer: x.layer, photo: x.photo } : { layer: x.layer, t: x.t },
      ),
      classMap: Object.fromEntries(Object.entries(classMap).filter(([, v]) => v !== '')),
      minConfidence: conf,
      ...(prefs.tile.on ? { tile: { size, overlap: Math.min(overlap, size - 1) } } : {}),
    });
  } finally {
    off();
  }
  if (!isLive(token)) return;
  // the review reads the pass the run wrote
  await loadDetections(projectId, true);
  patch(token, (r) => {
    const error = !res.ok ? res.error : !res.value.ok ? res.value.error : null;
    if (error !== null) return { phase: 'failed', error, remaining: rest(r, true) };
    const ok = res.ok && res.value.ok ? res.value : null;
    skipped = ok?.skipped ?? skipped;
    const stopped = r.phase === 'stopped' || r.done < r.total;
    return {
      phase: stopped ? 'stopped' : 'done',
      found: ok?.count ?? r.found,
      remaining: rest(r, false),
    };
  });
}

/** The pass a detector run writes (`detect.vlm`'s `vlm-<run>.json`). */
const vlmPassName = (runId: string) =>
  `vlm-${runId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 100)}.json`;

const photosOf = (run: PlannedRun): DetectItem[] =>
  run.photos.map((photo) => ({ kind: 'photo', layer: run.layer, photo }));

async function runDetectors(token: number, i: AskRunInput, chosen: Chosen[]): Promise<void> {
  const plan = planRuns(i.items, chosen);
  const ids = plan.runs.map(() => newRunId());
  patch(token, () => ({
    runIds: ids,
    total: plan.runs.reduce((n, r) => n + r.photos.length, 0),
  }));
  let stopped = false;
  /** Read through a function: Stop flips it while the starts await. */
  const isStopped = () => stopped;
  let unsub: (() => void) | null = null;
  const queued = new Set<string>();
  /** Runs that did not start, by index, with why. */
  const refused = new Map<number, string>();
  const jobOf = (id: string) =>
    jobs.getState().jobs.find((j) => j.pipeline === 'detect.vlm' && j.params.run === id);
  if (active?.token === token)
    active.stop = () => {
      stopped = true;
      unsub?.();
      ids.forEach((id, k) => {
        const job = jobOf(id);
        if (job && isActive(job)) void jobs.getState().cancel(job.id);
        // a run the gate still holds leaves the queue
        else if (!job && !refused.has(k)) void bridge.call('detect:queueCancel', { run: id });
      });
      patch(token, () => ({
        phase: 'stopped',
        remaining: plan.runs.flatMap((r, k) => {
          const id = ids[k];
          return id !== undefined && jobOf(id)?.status === 'done' ? [] : photosOf(r);
        }),
      }));
    };

  for (const [k, run] of plan.runs.entries()) {
    const id = ids[k];
    if (id === undefined || isStopped() || !isLive(token)) break;
    const error = await jobs.getState().start(runRequest(i.projectRoot, id, run));
    if (error === null) continue;
    // the gate answers a run it queued with an error: the queue says whether it waits
    const q = await bridge.call('detect:queue', {});
    const waits = q.ok && q.value.items.some((w) => w.run === id);
    if (waits || error === t('detect.preset.queued')) queued.add(id);
    else refused.set(k, error);
  }
  if (isStopped() || !isLive(token)) return;
  if (refused.size === plan.runs.length) {
    patch(token, () => ({
      phase: 'failed',
      error: [...refused.values()].join(' '),
      remaining: plan.runs.flatMap(photosOf),
    }));
    return;
  }

  const finish = async (failedRuns: number[], error: string | undefined) => {
    unsub?.();
    await loadDetections(i.projectId, true);
    const passes = new Set(ids.map(vlmPassName));
    patch(token, () => ({
      phase: failedRuns.length > 0 ? 'failed' : 'done',
      ...(error !== undefined ? { error } : {}),
      found: detections.getState().review.detections.filter((d) => passes.has(d.pass)).length,
      remaining: failedRuns.flatMap((k) => {
        const r = plan.runs[k];
        return r ? photosOf(r) : [];
      }),
    }));
  };

  let ending = false;
  const update = () => {
    if (ending || isStopped() || !isLive(token)) return;
    let done = 0;
    let ended = 0;
    let started = false;
    let error: string | undefined;
    const failedRuns: number[] = [];
    plan.runs.forEach((run, k) => {
      const why = refused.get(k);
      if (why !== undefined) {
        ended++;
        failedRuns.push(k);
        error ??= why;
        return;
      }
      const job = jobOf(ids[k] ?? '');
      if (!job) return;
      started = true;
      if (job.status === 'done') {
        done += run.photos.length;
        ended++;
        return;
      }
      done += Math.floor(job.progress * run.photos.length);
      if (!isActive(job)) {
        ended++;
        failedRuns.push(k);
        error ??= job.error;
      }
    });
    patch(token, () => ({
      done,
      phase: started || queued.size === 0 ? 'running' : 'queued',
    }));
    if (ended === plan.runs.length) {
      ending = true;
      void finish(failedRuns, error);
    }
  };
  unsub = jobs.subscribe(update);
  update();
}

export function stopAskRun(): void {
  if (busy(askAiRun.getState().run)) active?.stop();
}

/** Try again: the same backend on the items left (a local run continues under its own id). */
export async function retryAskRun(): Promise<void> {
  const run = askAiRun.getState().run;
  const a = active;
  if (!run || !a || busy(run) || run.remaining.length === 0) return;
  // the items left were part of what the person confirmed
  if (a.input.backend.kind === 'local') await begin(a.input, a.localRunId);
  else await begin({ ...a.input, items: run.remaining });
}

export function clearAskRun(): void {
  stopAskRun();
  active = null;
  askAiRun.setState({ run: null });
}

// a run belongs to its project: another project (or none) stops and clears it
workspace.subscribe((s) => {
  const run = askAiRun.getState().run;
  if (run && s.project?.id !== run.projectId) clearAskRun();
});
