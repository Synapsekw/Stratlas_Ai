import {
  ANALYTICS_PACK_SCHEMA,
  GPU_PIPELINES,
  VLM_DETECTOR_SCHEMA,
  ipcEvents,
  type AnalyticsPackManifest,
  type HardwareCheck,
  type JobRecord,
  type VlmDetector,
  type VlmServerState,
} from '@aio/schema';
import { en } from '@aio/ui/i18n/en';
import { localVlmModel } from './models';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DETECT_QUEUED,
  detectJobGate,
  detectLane,
  type GateAnswer,
  type GateDeps,
  type StartRequest,
} from './gate';
import type { AnalyticsPack } from './pack';

const SHA = 'd'.repeat(64);
const TUNED = 'e'.repeat(64);
const KEY = 'f'.repeat(32);
const DATA = 'D:/data';

const manifest: AnalyticsPackManifest = {
  schema: ANALYTICS_PACK_SCHEMA,
  version: '1.0.0',
  appRange: '>=0.25.0 <2.0.0',
  platform: 'win-x64',
  createdAt: '2026-10-01T00:00:00.000Z',
  runtime: { name: 'llama.cpp', release: 'b1', executable: 'llama/llama-server.exe' },
  model: { id: 'qwen-vl', licence: 'Apache-2.0', gguf: 'm.gguf', mmproj: 'p.gguf', sha256: SHA },
  detectors: [],
  files: {},
};
const PACK: AnalyticsPack = {
  version: '1.0.0',
  dir: 'D:/data/runtime/analytics-pack-1.0.0',
  manifest,
  server: 'D:/data/runtime/analytics-pack-1.0.0/llama/llama-server.exe',
  gguf: 'D:/data/runtime/analytics-pack-1.0.0/m.gguf',
  mmproj: 'D:/data/runtime/analytics-pack-1.0.0/p.gguf',
};

const det = (id: string, looksLike: string): VlmDetector => ({
  schema: VLM_DETECTOR_SCHEMA,
  id,
  name: `Detector ${id}`,
  version: 1,
  classId: 'defect',
  assetTypes: ['roof'],
  looksLike,
  ignore: '',
  question: 'Is this a defect?',
  tiles: { n: 2, overlap: 0.2, sendW: 1344, sendH: 1008 },
  threshold: 0.8,
  tunedOn: { model: 'qwen-tuned', modelSha256: TUNED },
  author: 'tester',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  source: 'user',
  status: 'experimental',
});

const STATE: VlmServerState = {
  url: 'http://127.0.0.1:51234',
  pid: 4000,
  apiKey: KEY,
  modelSha256: SHA,
  startedAt: '2026-10-21T00:00:00.000Z',
};

const newRequest = (run = 'run-abc'): StartRequest => ({
  pipeline: 'detect.vlm',
  project: 'D:/projects/site',
  params: {
    run,
    layer: 'photos',
    photos: ['p1'],
    detectors: [
      { where: 'library', detector: det('rust', 'INJECTED prompt text'), threshold: 0.7 },
      { where: 'shipped', detector: det('crack', 'also injected'), threshold: 0.9 },
    ],
    serverFile: 'C:/elsewhere.json',
  },
});

function deps(over: Partial<GateDeps> = {}) {
  const server = {
    ensure: vi.fn(() => Promise.resolve({ ok: true as const, state: STATE })),
    attach: vi.fn((url: string) => Promise.resolve({ ...STATE, url })),
    serves: vi.fn(() => false),
  };
  const hardware = vi.fn((minFreeMb: number): Promise<HardwareCheck> =>
    Promise.resolve({
      ok: true,
      gpu: 'GPU',
      gpuIndex: 1,
      totalMb: 16000,
      freeMb: Math.max(15000, minFreeMb),
    }),
  );
  const findPack = vi.fn(() => Promise.resolve(PACK as AnalyticsPack | null));
  const resolve = vi.fn((_o: unknown, refs: { where: string; id: string }[]) =>
    Promise.resolve(refs.map((r) => det(r.id, `stored ${r.where} ${r.id}`))),
  );
  const d: GateDeps = {
    env: {},
    dataRoot: DATA,
    projectDir: 'D:/projects/site',
    userData: 'C:/user',
    findPack,
    unusable: () => Promise.resolve([]),
    hardware,
    server,
    resolve,
    running: () => false,
    ...over,
  };
  return { d, server, hardware, findPack, resolve };
}

describe('detectJobGate', () => {
  it('missing pack refuses with pack.missing', async () => {
    const { d, server } = deps({ findPack: () => Promise.resolve(null) });
    expect(await detectJobGate(newRequest(), d)).toEqual({
      refuse: en['detect.preset.pack.missing'],
    });
    expect(server.ensure).not.toHaveBeenCalled();
  });

  it('no usable pack but an unusable one refuses with its reason, the newest first', async () => {
    const { d, server } = deps({
      findPack: () => Promise.resolve(null),
      unusable: () =>
        Promise.resolve([
          { version: '2.0.0', reason: 'Analytics pack 2.0.0 does not fit.' },
          { version: '1.0.0', reason: 'Analytics pack 1.0.0 is broken.' },
        ]),
    });
    expect(await detectJobGate(newRequest(), d)).toEqual({
      refuse: 'Analytics pack 2.0.0 does not fit.',
    });
    expect(server.ensure).not.toHaveBeenCalled();
  });

  it('hardware refusal passes its reason', async () => {
    const { d, server } = deps({
      hardware: () => Promise.resolve({ ok: false, reason: 'Too little memory.' }),
    });
    expect(await detectJobGate(newRequest(), d)).toEqual({ refuse: 'Too little memory.' });
    expect(server.ensure).not.toHaveBeenCalled();
  });

  it('hands the model floor to the hardware check', async () => {
    const { d, hardware } = deps();
    await detectJobGate(newRequest(), d);
    expect(hardware).toHaveBeenCalledWith(localVlmModel('qwen-vl').minFreeMb);
  });

  it('a server that does not start refuses with server.failed', async () => {
    const { d, server } = deps();
    server.ensure.mockResolvedValueOnce({ ok: false, error: 'it did not answer' } as never);
    expect(await detectJobGate(newRequest(), d)).toEqual({
      refuse: en['detect.preset.server.failed'].replace('{reason}', 'it did not answer'),
    });
  });

  it('a missing model program is its own sentence, not inside server.failed', async () => {
    const { d, server } = deps();
    server.ensure.mockResolvedValueOnce({
      ok: false,
      error: en['detect.preset.server.noExe'],
    } as never);
    expect(await detectJobGate(newRequest(), d)).toEqual({
      refuse: en['detect.preset.server.noExe'],
    });
  });

  it('skips the hardware check when the server already runs from this pack', async () => {
    const { d, server, hardware } = deps();
    server.serves.mockReturnValue(true);
    const r = await detectJobGate(newRequest(), d);
    expect('req' in r).toBe(true);
    expect(hardware).not.toHaveBeenCalled();
  });

  it('injects serverFile, model and sha', async () => {
    const { d, server } = deps();
    const r = await detectJobGate(newRequest(), d);
    if (!('req' in r) || !('params' in r.req)) throw new Error('expected a request');
    expect(r.req.params).toMatchObject({
      serverFile: join(DATA, 'runtime/analytics-server.json'),
      model: 'qwen-vl',
      modelSha256: SHA,
    });
    expect(server.ensure).toHaveBeenCalledWith(PACK, 1);
  });

  it('replaces detector bodies with stored copies', async () => {
    const { d, resolve } = deps();
    const r = await detectJobGate(newRequest(), d);
    if (!('req' in r) || !('params' in r.req)) throw new Error('expected a request');
    expect(resolve).toHaveBeenCalledWith(
      { pack: PACK, userData: 'C:/user', projectDir: 'D:/projects/site' },
      [
        { where: 'library', id: 'rust' },
        { where: 'shipped', id: 'crack' },
      ],
    );
    const items = r.req.params.detectors as { detector: VlmDetector; threshold: number }[];
    expect(items.map((i) => i.detector.looksLike)).toEqual([
      'stored library rust',
      'stored shipped crack',
    ]);
    expect(items.map((i) => i.threshold)).toEqual([0.7, 0.9]);
  });

  it('a detector that is gone refuses', async () => {
    const { d, server } = deps({
      resolve: () =>
        Promise.reject(new Error('The detector "rust" (library) is not there any more.')),
    });
    expect(await detectJobGate(newRequest(), d)).toEqual({
      refuse: 'The detector "rust" (library) is not there any more.',
    });
    expect(server.ensure).not.toHaveBeenCalled();
  });

  it('queues while one runs', async () => {
    const { d, server } = deps({ running: () => true });
    expect(await detectJobGate(newRequest(), d)).toEqual({ queue: true });
    expect(server.ensure).not.toHaveBeenCalled();
  });

  it('queues while a GPU pipeline job runs', async () => {
    const jobs = [{ pipeline: 'photo.align', status: 'running' }];
    const { d } = deps({
      running: () => jobs.some((j) => GPU_PIPELINES.has(j.pipeline as never)),
    });
    expect(GPU_PIPELINES.has('photo.align')).toBe(true);
    expect(await detectJobGate(newRequest(), d)).toEqual({ queue: true });
  });

  it('resume re-ensures the server and rewrites the state file', async () => {
    const { d, server, resolve } = deps();
    const r = await detectJobGate({ resume: 'job-1' }, d);
    expect(r).toEqual({ req: { resume: 'job-1' } });
    // ensure writes the state file every time, a reused server included
    expect(server.ensure).toHaveBeenCalledWith(PACK, 1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('QUADRION_VLM_SERVER_URL skips pack, hardware and spawn', async () => {
    const { d, server, hardware, findPack } = deps({
      env: { QUADRION_VLM_SERVER_URL: 'http://127.0.0.1:40000' },
    });
    const r = await detectJobGate(newRequest(), d);
    if (!('req' in r) || !('params' in r.req)) throw new Error('expected a request');
    expect(findPack).not.toHaveBeenCalled();
    expect(hardware).not.toHaveBeenCalled();
    expect(server.ensure).not.toHaveBeenCalled();
    expect(server.attach).toHaveBeenCalledWith('http://127.0.0.1:40000', TUNED);
    expect(r.req.params).toMatchObject({
      serverFile: join(DATA, 'runtime/analytics-server.json'),
      model: 'qwen-tuned',
      modelSha256: TUNED,
    });
  });

  it('queues when a photo job takes the card while the checks run', async () => {
    const running = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const { d, server, hardware } = deps({ running });
    expect(await detectJobGate(newRequest(), d)).toEqual({ queue: true });
    expect(hardware).toHaveBeenCalled();
    expect(server.ensure).not.toHaveBeenCalled();
  });

  it('a request without detectors refuses', async () => {
    const { d } = deps();
    const req = newRequest();
    if ('params' in req) req.params.detectors = [];
    expect('refuse' in (await detectJobGate(req, d))).toBe(true);
  });
});

// ---------------------------------------------------------------- the queue

const job = (id: string, pipeline: string, status: string) =>
  ({ id, pipeline, status }) as unknown as JobRecord;

function lane() {
  const jobs: JobRecord[] = [];
  const server = { idle: vi.fn() };
  const log = vi.fn();
  const gate = vi.fn((req: StartRequest, running: () => boolean) =>
    Promise.resolve(running() ? { queue: true as const } : { req }),
  );
  let n = 0;
  const start = vi.fn((req: StartRequest) => {
    n += 1;
    const pipeline = 'pipeline' in req ? req.pipeline : 'detect.vlm';
    const j = job(`job-${n}`, pipeline, 'starting');
    jobs.push(j);
    return Promise.resolve({ ok: true as const, job: j });
  });
  const card = { ask: false };
  const l = detectLane({
    gate,
    start,
    jobs: () => jobs,
    server,
    log,
    othersOnCard: () => card.ask,
  });
  const changed = vi.fn();
  l.onChange(changed);
  const end = async (id: string, status = 'done') => {
    const i = jobs.findIndex((j) => j.id === id);
    const was = jobs[i];
    if (!was) throw new Error(`no job ${id}`);
    const now = job(id, was.pipeline, status);
    jobs[i] = now;
    await l.settled({ type: 'update', job: now });
  };
  return { l, jobs, server, gate, start, end, log, changed, card };
}

describe('detectLane', () => {
  it('refuses photo GPU jobs while a local ask holds the card', () => {
    const t = lane();
    expect(t.l.gpuBusy('photo.align')).toBeNull();
    t.card.ask = true;
    expect(t.l.gpuBusy('photo.align')).toBe(en['detect.preset.gpuBusy']);
    expect(t.l.gpuBusy('walk.process')).toBeNull();
  });

  it('a waiting detector run waits for a local ask, then goes', async () => {
    const t = lane();
    t.card.ask = true;
    expect(await t.l.start(newRequest())).toEqual({ ok: false, error: DETECT_QUEUED });
    expect(t.l.waiting()).toHaveLength(1);
    t.card.ask = false;
    await t.l.askEnded();
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.l.waiting()).toHaveLength(0);
  });

  it('idleIfUnused stops the server only when no detector run is at work or waiting', async () => {
    const t = lane();
    t.l.idleIfUnused();
    expect(t.server.idle).toHaveBeenCalledTimes(1);
    await t.l.start(newRequest());
    t.l.idleIfUnused();
    expect(t.server.idle).toHaveBeenCalledTimes(1);
    await t.end('job-1');
    t.server.idle.mockClear();
    t.card.ask = true;
    await t.l.start(newRequest());
    expect(t.l.waiting()).toHaveLength(1);
    t.l.idleIfUnused();
    expect(t.server.idle).not.toHaveBeenCalled();
  });

  it('starts, queues behind a running one and starts it when that ends', async () => {
    const t = lane();
    const a = await t.l.start(newRequest());
    expect(a.ok).toBe(true);
    expect(await t.l.start(newRequest())).toEqual({ ok: false, error: DETECT_QUEUED });
    expect(DETECT_QUEUED).toBe(en['detect.preset.queued']);
    expect(t.l.waiting()).toHaveLength(1);
    await t.end('job-1');
    expect(t.start).toHaveBeenCalledTimes(2);
    expect(t.l.waiting()).toHaveLength(0);
    expect(t.server.idle).not.toHaveBeenCalled();
    await t.end('job-2', 'failed');
    expect(t.server.idle).toHaveBeenCalledTimes(1);
  });

  it('waits for a photo job, then runs', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.align', 'running'));
    expect(await t.l.start(newRequest())).toEqual({ ok: false, error: DETECT_QUEUED });
    await t.end('photo', 'cancelled');
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.server.idle).not.toHaveBeenCalled();
  });

  it('a queued request the gate refuses is logged and the next one goes', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.products', 'running'));
    await t.l.start(newRequest('run-a'));
    await t.l.start(newRequest('run-b'));
    t.gate.mockResolvedValueOnce({ refuse: 'No pack.' } as never);
    await t.end('photo');
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('No pack.'));
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it('a refused start leaves the server stopped', async () => {
    const t = lane();
    t.gate.mockResolvedValueOnce({ refuse: 'No.' } as never);
    expect(await t.l.start(newRequest())).toEqual({ ok: false, error: 'No.' });
    expect(t.server.idle).toHaveBeenCalledTimes(1);
  });

  it('two starts at once: the second waits', async () => {
    const t = lane();
    const [a, b] = await Promise.all([t.l.start(newRequest()), t.l.start(newRequest())]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: DETECT_QUEUED });
  });

  it('ignores jobs that do not use the graphics card', async () => {
    const t = lane();
    t.jobs.push(job('walk', 'walk.process', 'running'));
    expect((await t.l.start(newRequest())).ok).toBe(true);
    await t.end('walk');
    expect(t.server.idle).not.toHaveBeenCalled();
  });

  it('a queued run is listed and can be cancelled', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.align', 'running'));
    await t.l.start(newRequest('run-a'));
    await t.l.start(newRequest('run-b'));
    expect(t.l.waiting()).toHaveLength(2);
    const [a, b] = t.l.list();
    expect(a).toMatchObject({
      run: 'run-a',
      layer: 'photos',
      photos: 1,
      detectors: ['Detector rust', 'Detector crack'],
    });
    expect(Number.isNaN(Date.parse(a?.queuedAt ?? ''))).toBe(false);
    expect(b?.run).toBe('run-b');
    expect(t.changed).toHaveBeenLastCalledWith({ items: [a, b] });

    expect(t.l.cancel('run-a')).toEqual({ ok: true });
    expect(t.changed).toHaveBeenLastCalledWith({ items: [b] });
    expect(t.l.cancel('run-a')).toEqual({
      ok: false,
      error: en['detect.preset.queue.notWaiting'],
    });

    await t.end('photo');
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.start.mock.calls[0]?.[0]).toMatchObject({ params: { run: 'run-b' } });
    expect(t.changed).toHaveBeenLastCalledWith({ items: [] });
  });

  it('a queued start of the same run is not queued twice', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.align', 'running'));
    await t.l.start(newRequest('run-a'));
    expect(await t.l.start(newRequest('run-a'))).toEqual({ ok: false, error: DETECT_QUEUED });
    expect(t.l.list().map((i) => i.run)).toEqual(['run-a']);
  });

  it('a waiting run that fails to start is reported', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.georef', 'running'));
    await t.l.start(newRequest('run-a'));
    t.gate.mockResolvedValueOnce({ refuse: 'No pack.' } as never);
    await t.end('photo');
    expect(t.changed).toHaveBeenLastCalledWith({
      items: [],
      failed: { run: 'run-a', error: 'No pack.' },
    });
  });

  it('a photo job is refused while a detector run uses the card', async () => {
    const t = lane();
    expect((await t.l.start(newRequest())).ok).toBe(true);
    for (const p of ['photo.align', 'photo.georef', 'photo.products'])
      expect(t.l.gpuBusy(p)).toBe(en['detect.preset.gpuBusy']);
    expect(t.l.gpuBusy('walk.process')).toBeNull();
    await t.end('job-1');
    expect(t.l.gpuBusy('photo.align')).toBeNull();
  });

  it('a photo job may start while detector runs only wait', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.align', 'running'));
    await t.l.start(newRequest('run-a'));
    expect(t.l.list()).toHaveLength(1);
    expect(t.l.gpuBusy('photo.products')).toBeNull();
  });

  it('a run taken off the queue is announced at once, and again if it goes back', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.align', 'running'));
    await t.l.start(newRequest('run-a'));
    let open: (a: GateAnswer) => void = () => undefined;
    t.gate.mockImplementationOnce(() => new Promise<GateAnswer>((r) => (open = r)) as never);
    const ended = t.end('photo');
    await vi.waitFor(() => {
      expect(t.gate).toHaveBeenCalledTimes(2);
    });
    expect(t.changed).toHaveBeenLastCalledWith({ items: [] });
    expect(t.l.cancel('run-a')).toMatchObject({ ok: false });
    open({ queue: true });
    await ended;
    expect(t.l.list().map((i) => i.run)).toEqual(['run-a']);
    expect(t.changed).toHaveBeenLastCalledWith({ items: t.l.list() });
  });

  it.each([
    [
      'refuses',
      (open: (a: GateAnswer) => void) => {
        open({ refuse: 'No.' });
      },
    ],
    [
      'throws',
      (_o: unknown, fail: (e: Error) => void) => {
        fail(new Error('Broken.'));
      },
    ],
  ] as const)(
    'a photo job waits while a detector start passes the gate, then not when it %s',
    async (_n, finish) => {
      const t = lane();
      let open: (a: GateAnswer) => void = () => undefined;
      let fail: (e: Error) => void = () => undefined;
      t.gate.mockImplementationOnce(
        () =>
          new Promise<GateAnswer>((res, rej) => {
            open = res;
            fail = rej;
          }) as never,
      );
      const started = t.l.start(newRequest()).catch((e: unknown) => e);
      await vi.waitFor(() => {
        expect(t.gate).toHaveBeenCalledTimes(1);
      });
      expect(t.l.gpuBusy('photo.align')).toBe(en['detect.preset.gpuBusy']);
      finish(open, fail);
      await started;
      expect(t.l.gpuBusy('photo.align')).toBeNull();
    },
  );

  it('a waiting item the queue schema refuses is left out of the list and events', async () => {
    const t = lane();
    t.jobs.push(job('photo', 'photo.align', 'running'));
    const odd = newRequest('run-odd');
    if ('params' in odd) odd.params.layer = '';
    await t.l.start(odd);
    await t.l.start(newRequest('run-b'));
    expect(t.l.waiting()).toHaveLength(2);
    expect(t.l.list().map((i) => i.run)).toEqual(['run-b']);
    expect(ipcEvents['detect:queue'].safeParse(t.changed.mock.lastCall?.[0]).success).toBe(true);
  });
});
