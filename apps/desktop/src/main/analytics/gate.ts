/**
 * The `jobs:start` gate of a `detect.vlm` job, and the queue its starts wait in.
 *
 * The gate checks the Analytics pack, waits while the graphics card is taken, checks the card,
 * starts the model server, and hands on the request with the server file, the model and the
 * stored copy of each detector (a renderer cannot slip its own prompt text in under a known id).
 * The queue (`detectLane`) runs one detector run at a time, never beside a GPU pipeline job
 * (`GPU_PIPELINES`), first in first out, as the panorama stitch lane does; when nothing is left
 * running or waiting the server stops.
 */
import {
  DetectorWhere,
  GPU_PIPELINES,
  VLM_SERVER_STATE,
  type HardwareCheck,
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
  hardware: () => Promise<HardwareCheck>;
  server: Pick<VlmServer, 'ensure' | 'attach' | 'serves'>;
  resolve: typeof resolveDetectors;
  /** A `detect.vlm` or GPU pipeline job is at work (or another start is passing the gate). */
  running: () => boolean;
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
    const hw = await d.hardware();
    if (!hw.ok) return { refuse: hw.reason };
    gpuIndex = hw.gpuIndex;
  }
  const up = await d.server.ensure(pack, gpuIndex);
  if (!up.ok) {
    // a missing program is a sentence of its own: "did not start: ..." would say it twice
    const missing = up.error === en['detect.preset.server.noExe'];
    return {
      refuse: missing ? up.error : en['detect.preset.server.failed'].replace('{reason}', up.error),
    };
  }

  if (!isNew || !refs?.success) return { req };
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

/**
 * Detector runs one at a time and never beside a GPU pipeline job: a start that finds the card
 * taken waits here, first in first out, and goes through the gate again when a GPU job ends.
 * When nothing runs or waits, the server stops. The queue lives in memory only.
 */
export function detectLane(d: {
  /** `detectJobGate` with these `running`. */
  gate: (req: StartRequest, running: () => boolean) => Promise<GateAnswer>;
  /** The job runner's start. */
  start: (req: StartRequest) => Promise<StartResponse>;
  jobs: () => readonly Pick<JobRecord, 'id' | 'pipeline' | 'status'>[];
  server: Pick<VlmServer, 'idle'>;
  log: (line: string) => void;
}) {
  const waiting: StartRequest[] = [];
  /** Starts passing the gate now. */
  let passing = 0;
  let draining = false;

  const atWork = (pipelines: (p: PipelineName) => boolean) =>
    d.jobs().some((j) => pipelines(j.pipeline) && AT_WORK.has(j.status));
  const gpuAtWork = () => atWork((p) => GPU_PIPELINES.has(p));
  const detectAtWork = () => atWork((p) => p === 'detect.vlm');

  const same = (a: StartRequest, b: StartRequest) =>
    'resume' in a && 'resume' in b && a.resume === b.resume;

  /** One trip through the gate and, when it lets the request on, the runner. */
  async function pass(req: StartRequest, fromQueue: boolean): Promise<StartResponse> {
    passing += 1;
    try {
      const a = await d.gate(req, () => gpuAtWork() || passing > 1);
      if ('refuse' in a) return { ok: false, error: a.refuse };
      if ('queue' in a) {
        if (fromQueue) waiting.unshift(req);
        else if (!waiting.some((w) => same(w, req))) waiting.push(req);
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
        const req = waiting.shift();
        if (!req) break;
        let r: StartResponse;
        try {
          r = await pass(req, true);
        } catch (e) {
          r = { ok: false, error: message(e) };
        }
        if (r.ok) continue;
        if (r.error === DETECT_QUEUED) break;
        d.log(`A waiting detector run did not start: ${r.error}`);
      }
    } finally {
      draining = false;
    }
    if (waiting.length === 0 && passing === 0 && !detectAtWork()) d.server.idle();
  }

  return {
    /** `jobs:start` of a `detect.vlm` job, new or a resume. */
    async start(req: StartRequest): Promise<StartResponse> {
      if (waiting.length > 0) {
        if (!waiting.some((w) => same(w, req))) waiting.push(req);
        return { ok: false, error: DETECT_QUEUED };
      }
      let r: StartResponse;
      try {
        r = await pass(req, false);
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
    /** Waiting requests, oldest first (tests, diagnostics). */
    waiting(): readonly StartRequest[] {
      return [...waiting];
    },
  };
}
