/**
 * The one Ask AI run at a time, on the backend `resolveBackend` chose, with today's detection
 * code underneath: the cloud runner (`ai:detect` in batches), the local model (`inference:run`)
 * or the local detectors (`detect.vlm` jobs, one per photo layer). Whatever arrives stays: a run
 * that fails or is stopped keeps its suggestions and lists the items left, which Try again sends
 * on the same backend. Stop says "Stopping" until the run has ended (its pass written), then
 * "Stopped", never left "checking". A run belongs to its
 * project: opening another project stops and clears it, and nothing that arrives late from it is
 * added to the review. A cloud run never starts without the person's yes (`confirmed`, or the
 * project's "Don't ask again").
 *
 * A custom request (`custom`) runs as its own kind of run: one `ai:ask` per item (or one for a
 * pair of dates, drafts on the newer photo) on the route it was given, this PC or a named cloud
 * model, each answer's items added to the review as drafts as it arrives.
 */
import { ASK_PROMPT_VERSION, ASK_SEND_MAX_PX, sendSize, type AskRoute } from '@aio/ai';
import { aiPassName, type DetectionRun } from '@aio/annotate/detections';
import type { IpcEvent, ProjectManifest } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  itemKey,
  promptTaxonomy,
  toDraftDetections,
  type DetectItem,
} from '../../detections/convert';
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
import { cloudHint, providerLabelOf, type ResolvedBackend } from './backend';
import type { AskCheck } from './checks';
import { classMapFor, writeClassMap } from './classMap';
import { askItemsToDrafts, requestName, sendFields, type AskDraftRequest } from './custom';
import { cloudConfirmSkipped, rememberCheck, type AskAiPrefs } from './prefs';

export interface AskRun {
  runIds: string[];
  projectId: string;
  backend: 'detectors' | 'local' | 'cloud';
  /** A cloud run's provider, by the name people know it ("Anthropic"): Try again's tip names it. */
  provider?: string;
  /** What was looked at, as the strip says it ("All photos"). */
  what: string;
  /** The run looks at video frames, so the strip counts frames. */
  frames: boolean;
  total: number;
  done: number;
  found: number;
  /** `stopping`: Stop was pressed and the run is winding down; `stopped` once it has. */
  phase: 'queued' | 'running' | 'stopping' | 'done' | 'stopped' | 'failed';
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
  /**
   * A custom request: it runs on `route` (not `backend`), one ask per item, or one ask for `pair`
   * (Image 1 the older date, Image 2 the newer; drafts on `after`).
   */
  custom?: {
    request: AskDraftRequest;
    route: AskRoute;
    pair?: {
      before: DetectItem & { kind: 'photo' };
      after: DetectItem & { kind: 'photo' };
      labels: [string, string];
    };
  };
}

/** Where a run sends: a custom request's route, else the backend Ask AI resolved. */
const sendsToCloud = (i: AskRunInput) =>
  (i.custom ? i.custom.route.kind : i.backend.kind) === 'cloud';

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
/** Stop applies to a run that is going. */
const going = (r: AskRun | null) => r?.phase === 'running' || r?.phase === 'queued';
/** No other run starts until this one has ended. */
const busy = (r: AskRun | null) => going(r) || r?.phase === 'stopping';

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

/**
 * Read the review again for the pass a run wrote. A read that throws must not keep the run
 * going or stopping for good (Ask AI would stay off): the run ends on what the review holds.
 */
const reloadReview = (projectId: string): Promise<void> =>
  loadDetections(projectId, true).catch(() => undefined);

export async function startAskRun(i: AskRunInput): Promise<void> {
  if (sendsToCloud(i) && i.confirmed !== true && !cloudConfirmSkipped(i.projectId))
    throw new Error('A cloud run starts only once the person has confirmed what is sent.');
  if (busy(askAiRun.getState().run)) return;
  if (!i.custom) rememberCheck(i.projectId, i.check);
  await begin(i);
}

async function begin(i: AskRunInput, localRunId?: string): Promise<void> {
  const token = ++seq;
  active = { token, input: i, stop: () => undefined };
  if (i.custom) {
    await runCustom(token, i, i.custom);
    return;
  }
  askAiRun.setState({
    run: {
      runIds: [],
      projectId: i.projectId,
      backend: i.backend.kind,
      ...(i.backend.kind === 'cloud' ? { provider: providerLabelOf(i.backend.provider) } : {}),
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
          // stopping stays stopping while the batch in flight still answers
          const held = r.phase === 'stopping' && p.phase === 'running';
          return {
            done: p.imagesDone,
            total: p.images,
            found: p.found,
            phase: held ? 'stopping' : p.phase,
            ...(p.error !== undefined ? { error: p.error } : {}),
            remaining: p.phase === 'running' ? [] : p.remaining,
          };
        });
      },
      now: () => new Date().toISOString(),
    },
  );
  if (active?.token === token)
    active.stop = () => {
      runner.stop();
      patch(token, () => ({ phase: 'stopping' }));
    };
  await runner.done;
  // the runner ends with its own phase; a run still winding down ends here
  patch(token, (r) =>
    r.phase === 'stopping' ? { phase: 'stopped', remaining: items.slice(r.done) } : {},
  );
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
      patch(token, () => ({ phase: 'stopping' }));
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
  await reloadReview(projectId);
  patch(token, (r) => {
    const error = !res.ok ? res.error : !res.value.ok ? res.value.error : null;
    if (error !== null) return { phase: 'failed', error, remaining: rest(r, true) };
    const ok = res.ok && res.value.ok ? res.value : null;
    skipped = ok?.skipped ?? skipped;
    const stopped = r.phase === 'stopping' || r.done < r.total;
    return {
      phase: stopped ? 'stopped' : 'done',
      found: ok?.count ?? r.found,
      remaining: rest(r, false),
    };
  });
}

/** One ask of a custom run: the images sent, and the item its drafts land on. */
interface AskUnit {
  target: DetectItem;
  images: { item: DetectItem; label?: string }[];
}

/** An image of an ask as sent: its key, the JPEG, its sent size and its date label. */
interface SentImage {
  key: string;
  dataUrl: string;
  width: number;
  height: number;
  label?: string;
}

async function runCustom(
  token: number,
  i: AskRunInput,
  custom: NonNullable<AskRunInput['custom']>,
): Promise<void> {
  const { projectId, manifest } = i;
  const { request, route, pair } = custom;
  const units: AskUnit[] = pair
    ? [
        {
          target: pair.after,
          images: [
            { item: pair.before, label: pair.labels[0] },
            { item: pair.after, label: pair.labels[1] },
          ],
        },
      ]
    : i.items.map((item) => ({ target: item, images: [{ item }] }));
  const runId = runStamp();
  const pass = aiPassName(runId);
  const maxPx = ASK_SEND_MAX_PX[route.kind];
  const fields = sendFields(request);
  const classes = classesOf(manifest);
  askAiRun.setState({
    run: {
      runIds: [runId],
      projectId,
      backend: route.kind,
      ...(route.kind === 'cloud' ? { provider: providerLabelOf(route.provider) } : {}),
      what: requestName(request),
      frames: units.some((u) => u.target.kind === 'frame'),
      total: units.length,
      done: 0,
      found: 0,
      phase: 'running',
      remaining: [],
    },
  });
  noteAssessed(
    pass,
    units.flatMap((u) => (u.target.kind === 'photo' ? [u.target.photo] : [])),
  );

  let stopped = false;
  /** Read through a function: Stop flips it while a request awaits. */
  const isStopped = () => stopped;
  /** The ask in flight, which Stop cancels. */
  let current: string | null = null;
  if (active?.token === token)
    active.stop = () => {
      stopped = true;
      if (current !== null) void bridge.call('ai:cancel', { runId: current });
      patch(token, () => ({ phase: 'stopping' }));
    };

  let provider: string = route.kind === 'cloud' ? route.provider : 'local';
  let model = route.kind === 'cloud' ? route.model : '';
  let inputTokens = 0;
  let outputTokens = 0;
  /** Null once an answer had no price: the run then states no cost. */
  let cost: number | null = 0;
  let found = 0;
  let done = 0;
  /** The run ends with the items not answered; its run block is written once any answered. */
  const end = (phase: AskRun['phase'], from: number, error?: string) => {
    if (!isLive(token)) return;
    if (done > 0) {
      const run: DetectionRun = {
        id: runId,
        pass,
        at: new Date().toISOString(),
        provider,
        model,
        promptVersion: ASK_PROMPT_VERSION,
        images: done,
        detections: found,
        inputTokens,
        outputTokens,
        ...(cost !== null ? { costUsd: cost } : {}),
      };
      dispatch({ type: 'add', detections: [], label: t('det.ai.undoLabel'), run });
    }
    patch(token, () => ({
      phase,
      done,
      found,
      remaining: units.slice(from).map((u) => u.target),
      ...(error !== undefined ? { error } : {}),
    }));
  };

  for (const [n, unit] of units.entries()) {
    if (isStopped()) {
      end('stopped', n);
      return;
    }
    let images: SentImage[];
    let original = { width: 0, height: 0 };
    try {
      images = await Promise.all(
        unit.images.map(async ({ item, label }): Promise<SentImage> => {
          const p = await prepareItem(projectId, manifest.layers, item, maxPx);
          if (item === unit.target) original = { width: p.width, height: p.height };
          const [width, height] = sendSize(p.width, p.height, maxPx);
          return {
            key: itemKey(item),
            dataUrl: p.dataUrl,
            width,
            height,
            ...(label !== undefined ? { label } : {}),
          };
        }),
      );
    } catch (e) {
      end('failed', n, e instanceof Error ? e.message : String(e));
      return;
    }
    if (!isLive(token)) return;
    if (isStopped()) {
      end('stopped', n);
      return;
    }
    current = `${runId}-${String(n)}`;
    const res = await bridge.call('ai:ask', {
      runId: current,
      projectId,
      backend: route,
      kind: request.kind,
      prompt: request.prompt,
      fields,
      images,
      ...(request.wholeImage === true ? { wholeImage: true } : {}),
      ...(request.id !== undefined ? { requestId: request.id } : {}),
    });
    current = null;
    // a run of a project no longer open adds nothing
    if (!isLive(token)) return;
    const answer = res.ok ? res.value : { ok: false as const, error: res.error };
    if (!answer.ok) {
      if (isStopped() || ('stopped' in answer && answer.stopped === true)) end('stopped', n);
      else end('failed', n, answer.error);
      return;
    }
    provider = answer.provider;
    model = answer.model;
    inputTokens += answer.inputTokens;
    outputTokens += answer.outputTokens;
    cost = cost === null || answer.costUsd === undefined ? null : cost + answer.costUsd;
    const drafts = askItemsToDrafts({
      items: answer.items,
      item: unit.target,
      size: original,
      request,
      classes,
      runId,
      pass,
      provider: answer.provider,
      model: answer.model,
      now: new Date().toISOString(),
      newId: () => globalThis.crypto.randomUUID(),
    });
    if (drafts.length > 0)
      dispatch({ type: 'add', detections: drafts, label: t('det.ai.undoLabel') });
    done += 1;
    found += drafts.length;
    patch(token, () => ({ done, found }));
  }
  end(isStopped() ? 'stopped' : 'done', units.length);
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
  /** Cancel what still runs or waits. */
  const cancelAll = () => {
    ids.forEach((id, k) => {
      const job = jobOf(id);
      if (job && isActive(job)) void jobs.getState().cancel(job.id);
      // a run the gate still holds leaves the queue
      else if (!job && !refused.has(k)) void bridge.call('detect:queueCancel', { run: id });
    });
  };
  /** Stopping until no job of this run is active any more; then stopped, with what is left. */
  let settled = false;
  const settleStop = () => {
    if (settled) return;
    if (isLive(token) && ids.some((id) => isActive(jobOf(id) ?? { status: 'done' }))) return;
    settled = true;
    unsub?.();
    unsub = null;
    if (!isLive(token)) return;
    void reloadReview(i.projectId).then(() => {
      const passes = new Set(ids.map(vlmPassName));
      patch(token, () => ({
        phase: 'stopped',
        found: detections.getState().review.detections.filter((d) => passes.has(d.pass)).length,
        remaining: plan.runs.flatMap((r, k) => {
          const id = ids[k];
          return id !== undefined && jobOf(id)?.status === 'done' ? [] : photosOf(r);
        }),
      }));
    });
  };
  if (active?.token === token)
    active.stop = () => {
      stopped = true;
      cancelAll();
      patch(token, () => ({ phase: 'stopping' }));
      unsub?.();
      unsub = jobs.subscribe(settleStop);
      settleStop();
    };

  for (const [k, run] of plan.runs.entries()) {
    const id = ids[k];
    if (id === undefined || isStopped() || !isLive(token)) break;
    const error = await jobs.getState().start(runRequest(i.projectRoot, id, run));
    // a run that started while Stop was pressed is cancelled too
    if (isStopped()) {
      cancelAll();
      break;
    }
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
    await reloadReview(i.projectId);
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
  if (going(askAiRun.getState().run)) active?.stop();
}

/**
 * Try again: the same backend on the items left (a local run continues under its own id). The
 * items left were part of what the person confirmed, but `ai:detect` sends to whatever the
 * settings route vision to now: a cloud run tries again only while that is still the provider
 * and model confirmed, and ready. Otherwise nothing is sent and the answer says to press Ask AI
 * again, so the confirm shows.
 */
export async function retryAskRun(): Promise<{ refused: string } | undefined> {
  const run = askAiRun.getState().run;
  const a = active;
  if (!run || !a || busy(run) || run.remaining.length === 0) return undefined;
  const custom = a.input.custom;
  if (custom) {
    // a custom run's route is explicit and was confirmed: what is left goes to it again
    await begin(custom.pair ? a.input : { ...a.input, items: run.remaining });
    return undefined;
  }
  const b = a.input.backend;
  if (b.kind === 'cloud') {
    const status = await bridge.call('ai:status', { projectId: a.input.projectId, task: 'vision' });
    const route = status.ok && status.value.ready ? status.value.route : undefined;
    // the run may have changed while the status was read (a project change, Close)
    if (active !== a || askAiRun.getState().run !== run) return undefined;
    if (route?.provider !== b.provider || route.model !== b.model)
      return { refused: t('askAi.run.retryConfirm') };
  }
  if (b.kind === 'local') await begin(a.input, a.localRunId);
  else await begin({ ...a.input, items: run.remaining });
  return undefined;
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
