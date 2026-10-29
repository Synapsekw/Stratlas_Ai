/**
 * The `jobs:start` gate of a `detect.vlm` job, and the queue its starts wait in.
 *
 * The gate checks the Analytics pack, waits while the graphics card is taken, checks the card,
 * starts the model server, and hands on the request with the server file, the model and the
 * stored copy of each detector (a renderer cannot slip its own prompt text in under a known id).
 * The queue (`detectLane`) runs one detector run at a time, never beside a GPU pipeline job
 * (`GPU_PIPELINES`), first in first out, as the panorama stitch lane does; when nothing is left
 * running or waiting the server stops. The waiting runs can be listed and cancelled
 * (`detect:queue`), and a photo job may not start while a detector run holds the card.
 */
import {
  DetectQueued,
  DetectorWhere,
  GPU_PIPELINES,
  VLM_SERVER_STATE,
  type HardwareCheck,
  type IpcEvent,
  type IpcRequest,
  type IpcResponse,
  type JobEvent,
  type JobRecord,
  type PipelineName,
  type VlmDetector,
} from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { join } from 'node:path';
import { z } from 'zod';
import type { resolveDetectors } from './detectors';
import { localVlmModel } from './models';
import type { AnalyticsPack, UnusablePack } from './pack';
import type { VlmServer } from './server';

export type StartRequest = IpcRequest<'jobs:start'>;
export type StartResponse = IpcResponse<'jobs:start'>;
export type GateAnswer = { refuse: string } | { queue: true } | { req: StartRequest };

/** The answer of a start that waits in the queue (as `PANO_QUEUED`). */
export const DETECT_QUEUED: string = en['detect.preset.queued'];

export interface GateDeps {
  env: Record<string, string | undefined>;
  dataRoot: string;
  /** The project folder of the request. */
  projectDir: string;
  /** The user data folder: the detector library is `<userData>/detectors`. */
  userData: string;
  /** `findAnalyticsPack` for this app and computer. */
  findPack: (o: {
    dataRoot: string;
    env: Record<string, string | undefined>;
  }) => Promise<AnalyticsPack | null>;
  /** `unusablePacks` for this app and computer, newest first. */
  unusable: (o: {
    dataRoot: string;
    env: Record<string, string | undefined>;
  }) => Promise<UnusablePack[]>;
  /** The `checkHardware` result for this start. */
  hardware: (minFreeMb: number) => Promise<HardwareCheck>;
  server: Pick<VlmServer, 'ensure' | 'attach' | 'serves'>;
  resolve: typeof resolveDetectors;
  /** A `detect.vlm` or GPU pipeline job is at work (or another start is passing the gate). */
  running: () => boolean;
  /** The stored job of a resume. */
  job?: (id: string) => Pick<JobRecord, 'params'> | undefined;
  /** Write the pack's model and its sha into a resumed job's stored params. */
  restamp?: (id: string, model: { model: string; modelSha256: string }) => void;
}

/** What the gate reads of the request's detectors; the rest is checked by the job runner. */
const DetectorRefs = z
  .array(z.object({ where: DetectorWhere, detector: z.object({ id: z.string() }).loose() }).loose())
  .min(1);

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function detectJobGate(req: StartRequest, d: GateDeps): Promise<GateAnswer> {
  const serverFile = join(d.dataRoot, VLM_SERVER_STATE);
  const isNew = 'params' in req;
  const refs = isNew ? DetectorRefs.safeParse(req.params.detectors) : null;
  if (refs && !refs.success) return { refuse: 'Choose at least one detector for this run.' };

  // e2e: a fake server stands in for the pack, the card and llama-server
  const seam = d.env.QUADRION_VLM_SERVER_URL;
  if (seam) {
    if (d.running()) return { queue: true };
    if (!isNew || !refs?.success) return { req };
    let stored: VlmDetector[];
    try {
      stored = await d.resolve(
        { pack: null, userData: d.userData, projectDir: d.projectDir },
        refs.data.map((r) => ({ where: r.where, id: r.detector.id })),
      );
    } catch (e) {
      return { refuse: message(e) };
    }
    const tuned = stored[0]?.tunedOn;
    if (!tuned) return { refuse: 'Choose at least one detector for this run.' };
    try {
      await d.server.attach(seam, tuned.modelSha256);
    } catch (e) {
      return { refuse: message(e) };
    }
    return {
      req: withServer(req, refs.data, stored, serverFile, tuned.model, tuned.modelSha256),
    };
  }

  const where = { dataRoot: d.dataRoot, env: d.env };
  const pack = await d.findPack(where);
  if (!pack) {
    // a pack that is there but cannot be used says why, not "install the pack"
    const [newest] = await d.unusable(where);
    return { refuse: newest?.reason ?? en['detect.preset.pack.missing'] };
  }
  // nothing loads on the card while it is taken: the start waits in the queue
  if (d.running()) return { queue: true };

  let stored: VlmDetector[] = [];
  if (isNew && refs?.success) {
    try {
      stored = await d.resolve(
        { pack, userData: d.userData, projectDir: d.projectDir },
        refs.data.map((r) => ({ where: r.where, id: r.detector.id })),
      );
    } catch (e) {
      return { refuse: message(e) };
    }
  }

  // a server already loaded holds the memory the check looks for
  let gpuIndex: number | null = null;
  if (!d.server.serves(pack.dir)) {
    const hw = await d.hardware(localVlmModel(pack.manifest.model.id).minFreeMb);
    if (!hw.ok) return { refuse: hw.reason };
    gpuIndex = hw.gpuIndex;
  }
  // a photo job may have taken the card while the checks above ran
  if (d.running()) return { queue: true };
  const up = await d.server.ensure(pack, gpuIndex);
  if (!up.ok) {
    // a missing program is a sentence of its own: "did not start: ..." would say it twice
    const missing = up.error === en['detect.preset.server.noExe'];
    return {
      refuse: missing ? up.error : en['detect.preset.server.failed'].replace('{reason}', up.error),
    };
  }

  if (!isNew) {
    // a run stopped on an older pack resumes on this one's model: its boxes are read in the
    // frame of the model that answers them now
    const was = d.job?.(req.resume)?.params;
    const now = { model: pack.manifest.model.id, modelSha256: pack.manifest.model.sha256 };
    if (was && (was.model !== now.model || was.modelSha256 !== now.modelSha256))
      d.restamp?.(req.resume, now);
    return { req };
  }
  if (!refs?.success) return { req };
  return {
    req: withServer(
      req,
      refs.data,
      stored,
      serverFile,
      pack.manifest.model.id,
      pack.manifest.model.sha256,
    ),
  };
}

function withServer(
  req: Extract<StartRequest, { params: unknown }>,
  items: readonly Record<string, unknown>[],
  stored: readonly VlmDetector[],
  serverFile: string,
  model: string,
  modelSha256: string,
): StartRequest {
  return {
    ...req,
    params: {
      ...req.params,
      detectors: items.map((item, i) => ({ ...item, detector: stored[i] })),
      serverFile,
      model,
      modelSha256,
    },
  };
}

// ---------------------------------------------------------------- the queue

/** `JobStatus` values of a job at work (`interrupted` waits for a resume and holds nothing). */
const AT_WORK: ReadonlySet<string> = new Set(['starting', 'running', 'cancelling']);
const ENDED: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'interrupted']);

/** The photo jobs a detector run on the card holds back (`GPU_PIPELINES` but `detect.vlm`). */
const PHOTO_GPU: ReadonlySet<string> = new Set(
  [...GPU_PIPELINES].filter((p) => p !== 'detect.vlm'),
);

export type DetectQueueEvent = IpcEvent<'detect:queue'>;

/** A waiting start and what `detect:queue` shows of it. */
interface Waiting {
  req: StartRequest;
  item: DetectQueued;
}

/**
 * Detector runs one at a time and never beside a GPU pipeline job: a start that finds the card
 * taken waits here, first in first out, and goes through the gate again when a GPU job ends.
 * When nothing runs or waits, the server stops. The queue lives in memory only; a run waits once
 * (keyed by `params.run`), and every change goes to the `onChange` listeners.
 */
export function detectLane(d: {
  /** `detectJobGate` with these `running`. */
  gate: (req: StartRequest, running: () => boolean) => Promise<GateAnswer>;
  /** The job runner's start. */
  start: (req: StartRequest) => Promise<StartResponse>;
  jobs: () => readonly Pick<JobRecord, 'id' | 'pipeline' | 'status'>[];
  /** The stored job of a resume: its params name the run. */
  job?: (id: string) => Pick<JobRecord, 'params'> | undefined;
  server: Pick<VlmServer, 'idle'>;
  /** A local ask holds the card: photo GPU jobs are refused and waiting runs wait. */
  othersOnCard?: () => boolean;
  log: (line: string) => void;
}) {
  const waiting: Waiting[] = [];
  const listeners: ((e: DetectQueueEvent) => void)[] = [];
  /** Starts passing the gate now. */
  let passing = 0;
  let draining = false;

  const atWork = (pipelines: (p: PipelineName) => boolean) =>
    d.jobs().some((j) => pipelines(j.pipeline) && AT_WORK.has(j.status));
  const onCard = () => d.othersOnCard?.() === true;
  const gpuAtWork = () => atWork((p) => GPU_PIPELINES.has(p)) || onCard();
  const detectAtWork = () => atWork((p) => p === 'detect.vlm');

  /** What `detect:queue` shows: an item its schema refuses is left out, not the whole event. */
  const list = (): DetectQueued[] =>
    waiting.flatMap((w) => (DetectQueued.safeParse(w.item).success ? [w.item] : []));

  function changed(failed?: { run: string; error: string }): void {
    const e: DetectQueueEvent = failed ? { items: list(), failed } : { items: list() };
    for (const cb of listeners) cb(e);
  }

  /** What the queue shows of a start: its own params, or the stored job's for a resume. */
  function itemOf(req: StartRequest): DetectQueued {
    const params: Record<string, unknown> =
      'params' in req ? req.params : (d.job?.(req.resume)?.params ?? {});
    const detectors: unknown[] = Array.isArray(params.detectors) ? params.detectors : [];
    return {
      run: typeof params.run === 'string' ? params.run : 'resume' in req ? req.resume : '',
      layer: typeof params.layer === 'string' ? params.layer : '',
      photos: Array.isArray(params.photos) ? params.photos.length : 0,
      detectors: detectors.flatMap((x) => {
        const name = (x as { detector?: { name?: unknown } } | null)?.detector?.name;
        return typeof name === 'string' ? [name] : [];
      }),
      queuedAt: new Date().toISOString(),
    };
  }

  /** Wait at the back of the queue, once per run. */
  function enqueue(req: StartRequest): void {
    const item = itemOf(req);
    if (item.run && waiting.some((w) => w.item.run === item.run)) return;
    waiting.push({ req, item });
    changed();
  }

  /** One trip through the gate and, when it lets the request on, the runner. */
  async function pass(req: StartRequest, from?: Waiting): Promise<StartResponse> {
    passing += 1;
    try {
      const a = await d.gate(req, () => gpuAtWork() || passing > 1);
      if ('refuse' in a) return { ok: false, error: a.refuse };
      if ('queue' in a) {
        // a run taken from the queue goes back to the front as it was
        if (from) {
          waiting.unshift(from);
          changed();
        } else enqueue(req);
        return { ok: false, error: DETECT_QUEUED };
      }
      return await d.start(a.req);
    } finally {
      passing -= 1;
    }
  }

  /** Start the next waiting request when the card is free; stop the server when none is left. */
  async function settle(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (waiting.length > 0 && passing === 0 && !gpuAtWork()) {
        const next = waiting.shift();
        if (!next) break;
        // passing the gate now: no longer waiting, so it can no longer be cancelled here
        changed();
        let r: StartResponse;
        try {
          r = await pass(next.req, next);
        } catch (e) {
          r = { ok: false, error: message(e) };
        }
        if (r.ok) continue;
        if (r.error === DETECT_QUEUED) break;
        d.log(`A waiting detector run did not start: ${r.error}`);
        changed({ run: next.item.run, error: r.error });
      }
    } finally {
      draining = false;
    }
    idleIfUnused();
  }

  /** Stop the server when no detector run is at work, passing or waiting. */
  function idleIfUnused(): void {
    if (waiting.length === 0 && passing === 0 && !detectAtWork()) d.server.idle();
  }

  return {
    /** `jobs:start` of a `detect.vlm` job, new or a resume. */
    async start(req: StartRequest): Promise<StartResponse> {
      if (waiting.length > 0) {
        enqueue(req);
        return { ok: false, error: DETECT_QUEUED };
      }
      let r: StartResponse;
      try {
        r = await pass(req);
      } finally {
        await settle();
      }
      return r;
    },
    /** A job event: a GPU job ended, the next waiting run goes. */
    async settled(e: JobEvent): Promise<void> {
      if (e.type !== 'update' || !GPU_PIPELINES.has(e.job.pipeline) || !ENDED.has(e.job.status))
        return;
      await settle();
    },
    /** A local ask ended: the next waiting detector run goes. */
    askEnded(): Promise<void> {
      return settle();
    },
    idleIfUnused,
    /** Waiting requests, oldest first (tests, diagnostics). */
    waiting(): readonly StartRequest[] {
      return waiting.map((w) => w.req);
    },
    /** `detect:queue`: the waiting runs, oldest first. */
    list,
    /** `detect:queueCancel`: take a waiting run out; one already passing the gate is not waiting. */
    cancel(run: string): { ok: boolean; error?: string } {
      const i = waiting.findIndex((w) => w.item.run === run);
      if (i < 0) return { ok: false, error: en['detect.preset.queue.notWaiting'] };
      waiting.splice(i, 1);
      changed();
      return { ok: true };
    },
    /** Every change of the waiting runs; main sends it as the `detect:queue` event. */
    onChange(cb: (e: DetectQueueEvent) => void): void {
      listeners.push(cb);
    },
    /**
     * Why a photo job may not start now, else null: a detector run holds the card while its job
     * is at work or its start is passing the gate (loading the model). Waiting runs hold nothing.
     */
    gpuBusy(pipeline: string): string | null {
      return PHOTO_GPU.has(pipeline) && (detectAtWork() || passing > 0 || onCard())
        ? en['detect.preset.gpuBusy']
        : null;
    },
  };
}
