// @vitest-environment jsdom
import type { IpcRequest, JobRecord, ProjectManifest, VlmDetector } from '@aio/schema';
import { t } from '@aio/ui';
import { workspace } from '@aio/workspace';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';
import type { DetectItem } from '../../detections/convert';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const h = vi.hoisted(() => ({
  calls: [] as { channel: string; req: unknown }[],
  detect: [] as { req: IpcRequest<'ai:detect'>; answer: Deferred<unknown> }[],
  inference: null as Deferred<unknown> | null,
  queueStarted: false,
  started: [] as IpcRequest<'jobs:start'>[],
  startAnswer: null as string | null,
  progress: [] as ((e: unknown) => void)[],
}));

vi.mock('../../shell', async () => {
  const { createStore } = await import('zustand/vanilla');
  const jobs = createStore(() => ({
    jobs: [] as JobRecord[],
    start: (req: IpcRequest<'jobs:start'>) => {
      h.started.push(req);
      return Promise.resolve(h.startAnswer);
    },
    cancel: () => Promise.resolve(null),
  }));
  return {
    jobs,
    bridge: {
      call: (channel: string, req: unknown) => {
        h.calls.push({ channel, req });
        if (channel === 'ai:detect') {
          const answer = deferred<unknown>();
          h.detect.push({ req: req as IpcRequest<'ai:detect'>, answer });
          return answer.promise;
        }
        if (channel === 'inference:run') {
          h.inference = deferred<unknown>();
          return h.inference.promise;
        }
        if (channel === 'detect:queue')
          return Promise.resolve({
            ok: true,
            value: {
              items: h.queueStarted
                ? h.started.map((r) => ({
                    run: (r as unknown as { params: { run: string } }).params.run,
                  }))
                : [],
            },
          });
        return Promise.resolve({ ok: false, error: 'not in this test' });
      },
    },
  };
});
vi.mock('../../detections/prepare', () => ({
  prepareItem: () =>
    Promise.resolve({ dataUrl: 'data:image/jpeg;base64,x', width: 4000, height: 3000 }),
}));

const shell = (await import('../../shell')) as unknown as {
  jobs: StoreApi<{ jobs: JobRecord[] }>;
};
const { detections } = await import('../../detections/store');
const { askAiRun, clearAskRun, retryAskRun, startAskRun, stopAskRun } = await import('./runs');
const { readPrefs, lastCheck, skipCloudConfirm } = await import('./prefs');

const MANIFEST = {
  layers: [
    { kind: 'photos', id: 'ph', name: 'Photos', items: [] },
    { kind: 'photos', id: 'ph2', name: 'More', items: [] },
  ],
  severityModels: [],
  classCatalogues: [{ assetType: 'tank', classes: [{ id: 'corrosion', label: 'Corrosion' }] }],
} as unknown as ProjectManifest;
const PROJECT = { id: 'p', root: '/projects/p', manifest: MANIFEST };
const OTHER = { id: 'q', root: '/projects/q', manifest: MANIFEST };

const photos = (n: number, layer = 'ph'): DetectItem[] =>
  Array.from({ length: n }, (_, i) => ({ kind: 'photo', layer, photo: `${layer}-${String(i)}` }));

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

function answerOk(n: number) {
  const d = h.detect[n];
  if (!d) throw new Error(`no batch ${String(n)}`);
  d.answer.resolve({
    ok: true,
    value: {
      ok: true,
      provider: 'anthropic',
      model: 'claude-x',
      promptVersion: 'detect-v1',
      results: d.req.images.map((im) => ({
        key: im.key,
        detections: [{ classId: 'corrosion', label: 'corrosion', box: [0.1, 0.1, 0.2, 0.2] }],
      })),
      inputTokens: 10,
      outputTokens: 10,
      costUsd: 0.01,
      warnings: [],
    },
  });
}

const cloud = (items: DetectItem[], over: object = {}) =>
  startAskRun({
    projectId: 'p',
    projectRoot: '/projects/p',
    manifest: MANIFEST,
    items,
    check: { kind: 'class', classId: 'corrosion' },
    what: 'All photos',
    backend: { kind: 'cloud', provider: 'anthropic', model: 'claude-x' },
    prefs: { ...readPrefs(), cloudBatch: 2 },
    confirmed: true,
    ...over,
  });

beforeEach(() => {
  h.calls = [];
  h.detect = [];
  h.inference = null;
  h.queueStarted = false;
  h.started = [];
  h.startAnswer = null;
  h.progress = [];
  window.localStorage.clear();
  (window as unknown as { aio: unknown }).aio = {
    on: (channel: string, cb: (e: unknown) => void) => {
      if (channel !== 'inference:progress') return () => undefined;
      h.progress.push(cb);
      return () => {
        h.progress = h.progress.filter((f) => f !== cb);
      };
    },
  };
  workspace.setState({ project: PROJECT, issues: [] });
  detections.setState({
    projectId: 'p',
    readOnly: false,
    review: { ...detections.getState().review, detections: [] },
  });
  shell.jobs.setState({ jobs: [] });
});
afterEach(() => {
  clearAskRun();
});

describe('Ask AI runs', () => {
  it('does not send to the cloud before the person confirms', async () => {
    await expect(cloud(photos(2), { confirmed: false })).rejects.toThrow();
    expect(h.calls.filter((c) => c.channel === 'ai:detect')).toHaveLength(0);
    expect(askAiRun.getState().run).toBeNull();
    skipCloudConfirm('p');
    void cloud(photos(2), { confirmed: false });
    await flush();
    expect(h.detect).toHaveLength(1);
  });

  it('streams cloud suggestions into the review as batches answer', async () => {
    void cloud(photos(4));
    await flush();
    expect(askAiRun.getState().run).toMatchObject({
      projectId: 'p',
      backend: 'cloud',
      what: 'All photos',
      frames: false,
      total: 4,
      done: 0,
      phase: 'running',
    });
    expect(lastCheck('p')).toEqual({ kind: 'class', classId: 'corrosion' });
    expect(h.detect[0]?.req.hint).toBe('Corrosion');
    answerOk(0);
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ done: 2, found: 2, phase: 'running' });
    expect(detections.getState().review.detections).toHaveLength(2);
    answerOk(1);
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ done: 4, found: 4, phase: 'done' });
    expect(askAiRun.getState().run?.remaining).toEqual([]);
    expect(detections.getState().review.detections).toHaveLength(4);
  });

  it('keeps what arrived when a cloud run fails', async () => {
    void cloud(photos(4));
    await flush();
    answerOk(0);
    await flush();
    h.detect[1]?.answer.resolve({ ok: true, value: { ok: false, error: 'rate limited' } });
    await flush();
    expect(askAiRun.getState().run).toMatchObject({
      phase: 'failed',
      error: 'rate limited',
      found: 2,
    });
    expect(detections.getState().review.detections).toHaveLength(2);
    expect(askAiRun.getState().run?.remaining).toHaveLength(2);

    // Try again sends the two left, without a new confirm
    void retryAskRun();
    await flush();
    expect(h.detect).toHaveLength(3);
    expect(h.detect[2]?.req.images.map((i) => i.key)).toHaveLength(2);
    expect(askAiRun.getState().run).toMatchObject({ total: 2, phase: 'running' });
  });

  it('says stopping until a stopped cloud run ends, and keeps a late batch', async () => {
    void cloud(photos(4));
    await flush();
    stopAskRun();
    expect(askAiRun.getState().run?.phase).toBe('stopping');
    expect(h.calls.some((c) => c.channel === 'ai:cancel')).toBe(true);
    answerOk(0);
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ phase: 'stopped', done: 2 });
    expect(askAiRun.getState().run?.remaining).toHaveLength(2);
  });

  it('stops a local run: stopping until the run answers, then stopped, not running', async () => {
    window.localStorage.setItem(
      'stratlas.detect.classMap.p.yolo',
      JSON.stringify({ rust: 'corrosion' }),
    );
    const model = {
      id: 'yolo',
      card: {
        name: 'Yolo',
        classes: ['rust', 'Corrosion', 'bird'],
        minConfidence: 0.3,
        input: { width: 640, height: 640 },
      },
    };
    void startAskRun({
      projectId: 'p',
      projectRoot: '/projects/p',
      manifest: MANIFEST,
      items: photos(3),
      check: { kind: 'everything' },
      what: 'All photos',
      backend: { kind: 'local', model: model as never },
      prefs: { ...readPrefs(), tile: { on: true, size: null, overlap: null } },
    });
    await flush();
    const req = h.calls.find((c) => c.channel === 'inference:run')
      ?.req as IpcRequest<'inference:run'>;
    expect(req).toMatchObject({
      projectId: 'p',
      model: 'yolo',
      classMap: { rust: 'corrosion', Corrosion: 'corrosion' },
      minConfidence: 0.3,
      tile: { size: 640, overlap: 128 },
    });
    expect(
      JSON.parse(window.localStorage.getItem('stratlas.detect.classMap.p.yolo') ?? ''),
    ).toEqual({ rust: 'corrosion', Corrosion: 'corrosion', bird: '' });
    h.progress.forEach((f) => {
      f({ runId: 'other', done: 3, total: 3, found: 9 });
      f({ runId: req.runId, done: 1, total: 3, found: 2 });
    });
    expect(askAiRun.getState().run).toMatchObject({ backend: 'local', done: 1, found: 2 });
    stopAskRun();
    expect(h.calls.some((c) => c.channel === 'inference:cancel')).toBe(true);
    // the run still writes its pass: not stopped before it answers
    expect(askAiRun.getState().run?.phase).toBe('stopping');
    h.inference?.resolve({ ok: true, value: { ok: true, file: 'model-x.json', count: 2 } });
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ phase: 'stopped', done: 1, found: 2 });
    expect(askAiRun.getState().run?.remaining).toHaveLength(2);
    expect(h.calls.some((c) => c.channel === 'detections:read')).toBe(true);

    // Try again continues the same run on every item: the run skips what it already read
    void retryAskRun();
    await flush();
    const again = h.calls.filter((c) => c.channel === 'inference:run').at(-1)
      ?.req as IpcRequest<'inference:run'>;
    expect(again.runId).toBe(req.runId);
    expect(again.items).toHaveLength(3);
  });

  it('starts one run when asked twice at once', async () => {
    void cloud(photos(2));
    void cloud(photos(2));
    await flush();
    expect(h.detect).toHaveLength(1);
  });

  it('does not start another run while one is stopping', async () => {
    void cloud(photos(4));
    await flush();
    stopAskRun();
    void cloud(photos(2));
    await flush();
    expect(h.detect).toHaveLength(1);
    expect(askAiRun.getState().run).toMatchObject({ phase: 'stopping', total: 4 });
  });

  it('drops a run when the project changes', async () => {
    void cloud(photos(2));
    await flush();
    workspace.setState({ project: OTHER });
    expect(askAiRun.getState().run).toBeNull();
    answerOk(0);
    await flush();
    // the late answer of the old run is not dispatched
    expect(detections.getState().review.detections).toHaveLength(0);
    expect(askAiRun.getState().run).toBeNull();
  });

  it('starts one detect.vlm job per photo layer with the detector threshold', async () => {
    const detector = { id: 'rust-v1', name: 'Rust', classId: 'corrosion', threshold: 0.9 };
    void startAskRun({
      projectId: 'p',
      projectRoot: '/projects/p',
      manifest: MANIFEST,
      items: [...photos(2), ...photos(1, 'ph2')],
      check: { kind: 'class', classId: 'corrosion' },
      what: 'All photos',
      backend: {
        kind: 'detectors',
        chosen: [
          { where: 'library', detector: detector as unknown as VlmDetector, threshold: 0.65 },
        ],
      },
      prefs: readPrefs(),
    });
    await flush();
    expect(h.started).toHaveLength(2);
    expect(h.started[1]).toMatchObject({ pipeline: 'detect.vlm', params: { layer: 'ph2' } });
    expect(h.started[0]).toMatchObject({
      pipeline: 'detect.vlm',
      project: '/projects/p',
      params: { layer: 'ph', photos: ['ph-0', 'ph-1'], detectors: [{ threshold: 0.65 }] },
    });
    const run = askAiRun.getState().run;
    expect(run).toMatchObject({ backend: 'detectors', total: 3, phase: 'running' });
    expect(run?.runIds).toHaveLength(2);

    const job = (i: number, status: JobRecord['status'], progress: number) =>
      ({
        id: `j${String(i)}`,
        pipeline: 'detect.vlm',
        project: '/projects/p',
        params: { run: run?.runIds[i] },
        status,
        progress,
      }) as unknown as JobRecord;
    shell.jobs.setState({ jobs: [job(0, 'running', 0.5), job(1, 'starting', 0)] });
    expect(askAiRun.getState().run).toMatchObject({ done: 1, phase: 'running' });
    shell.jobs.setState({ jobs: [job(0, 'done', 1), job(1, 'done', 1)] });
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ done: 3, phase: 'done' });
  });

  it('stops detector runs: stopping until their jobs end, then stopped', async () => {
    const detector = { id: 'rust-v1', name: 'Rust', classId: 'corrosion', threshold: 0.9 };
    void startAskRun({
      projectId: 'p',
      projectRoot: '/projects/p',
      manifest: MANIFEST,
      items: photos(2),
      check: { kind: 'everything' },
      what: 'All photos',
      backend: {
        kind: 'detectors',
        chosen: [
          { where: 'library', detector: detector as unknown as VlmDetector, threshold: 0.7 },
        ],
      },
      prefs: readPrefs(),
    });
    await flush();
    const id = askAiRun.getState().run?.runIds[0];
    const job = (status: JobRecord['status']) =>
      ({
        id: 'j0',
        pipeline: 'detect.vlm',
        project: '/projects/p',
        params: { run: id },
        status,
        progress: 0.5,
      }) as unknown as JobRecord;
    shell.jobs.setState({ jobs: [job('running')] });
    stopAskRun();
    expect(askAiRun.getState().run?.phase).toBe('stopping');
    shell.jobs.setState({ jobs: [job('cancelled')] });
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ phase: 'stopped' });
    expect(askAiRun.getState().run?.remaining).toHaveLength(2);
  });

  it('says a detector run waits while the queue holds it', async () => {
    h.startAnswer = 'Waiting for the graphics card.';
    h.queueStarted = true;
    const detector = { id: 'rust-v1', name: 'Rust', classId: 'corrosion', threshold: 0.9 };
    await startAskRun({
      projectId: 'p',
      projectRoot: '/projects/p',
      manifest: MANIFEST,
      items: photos(2),
      check: { kind: 'everything' },
      what: 'All photos',
      backend: {
        kind: 'detectors',
        chosen: [
          { where: 'library', detector: detector as unknown as VlmDetector, threshold: 0.7 },
        ],
      },
      prefs: readPrefs(),
    });
    await flush();
    expect(askAiRun.getState().run?.phase).toBe('queued');
  });
  const localModel = {
    id: 'yolo',
    card: {
      name: 'Yolo',
      classes: ['rust'],
      minConfidence: 0.3,
      input: { width: 640, height: 640 },
    },
  };
  const frames = (n: number): DetectItem[] =>
    Array.from({ length: n }, (_, i) => ({ kind: 'frame', layer: 'w1', t: 1 + i * 2 }));
  const localFrames = (items: DetectItem[]) =>
    startAskRun({
      projectId: 'p',
      projectRoot: '/projects/p',
      manifest: MANIFEST,
      items,
      check: { kind: 'everything' },
      what: 'Frames',
      backend: { kind: 'local', model: localModel as never },
      prefs: readPrefs(),
    });

  it('sends walk frames to the local model as layer and time, counted as frames', async () => {
    void localFrames(frames(5));
    await flush();
    const req = h.calls.find((c) => c.channel === 'inference:run')
      ?.req as IpcRequest<'inference:run'>;
    expect(req.items).toEqual([1, 3, 5, 7, 9].map((time) => ({ layer: 'w1', t: time })));
    expect('tile' in req).toBe(false);
    expect(askAiRun.getState().run).toMatchObject({ frames: true, total: 5, phase: 'running' });
  });

  it('keeps the frames that could not be read as the ones left to try again', async () => {
    void localFrames(frames(5));
    await flush();
    const req = h.calls.find((c) => c.channel === 'inference:run')
      ?.req as IpcRequest<'inference:run'>;
    h.progress.forEach((f) => {
      f({ runId: req.runId, done: 5, total: 5, found: 0, skipped: 2 });
    });
    h.inference?.resolve({
      ok: true,
      value: { ok: true, file: 'f.json', count: 0, skipped: 2, reason: "the codec can't be read" },
    });
    await flush();
    // the frames not read are not assessed: the same run tries them again
    expect(askAiRun.getState().run).toMatchObject({ phase: 'done', done: 5 });
    expect(askAiRun.getState().run?.remaining).toEqual(frames(5).slice(3));
  });

  it('fails with the reason, not done, when no frame could be read', async () => {
    void localFrames(frames(5));
    await flush();
    const error = 'None of the 5 frames could be read: ffmpeg could not be started';
    h.inference?.resolve({ ok: true, value: { ok: false, error } });
    await flush();
    expect(askAiRun.getState().run).toMatchObject({ phase: 'failed', error });
    expect(askAiRun.getState().run?.remaining).toHaveLength(5);
  });

  const detectorRun = (items: DetectItem[]) =>
    startAskRun({
      projectId: 'p',
      projectRoot: '/projects/p',
      manifest: MANIFEST,
      items,
      check: { kind: 'everything' },
      what: 'All photos',
      backend: {
        kind: 'detectors',
        chosen: [
          {
            where: 'library',
            detector: {
              id: 'rust-v1',
              name: 'Rust',
              classId: 'corrosion',
            } as unknown as VlmDetector,
            threshold: 0.8,
          },
        ],
      },
      prefs: readPrefs(),
    });

  it('fails with the reason and keeps the photos when the detector run is refused', async () => {
    h.startAnswer = 'The detector model did not start: no exe';
    await detectorRun(photos(2));
    await flush();
    expect(askAiRun.getState().run).toMatchObject({
      phase: 'failed',
      error: 'The detector model did not start: no exe',
    });
    expect(askAiRun.getState().run?.remaining).toHaveLength(2);
  });

  it('counts the queue message as queued even when the queue no longer lists the run', async () => {
    h.startAnswer = t('detect.preset.queued');
    await detectorRun(photos(2));
    await flush();
    expect(askAiRun.getState().run?.phase).toBe('queued');
    expect(askAiRun.getState().run?.error).toBeUndefined();
  });

  it('joins the reasons when every run of several is refused', async () => {
    h.startAnswer = 'Out of memory.';
    await detectorRun([...photos(1), ...photos(1, 'ph2')]);
    await flush();
    expect(h.started).toHaveLength(2);
    expect(askAiRun.getState().run).toMatchObject({
      phase: 'failed',
      error: 'Out of memory. Out of memory.',
    });
    expect(askAiRun.getState().run?.remaining).toHaveLength(2);
  });
});
