import { DetectionsFile, type IpcEvent, type ProjectManifest, type WalkFile } from '@aio/schema';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectHandlers } from '../notYet';
import {
  markerCard,
  markerDetectorOnnx,
  markerPhotoRgba,
  type MarkerPatch,
} from './fixtures/markerDetector';
import { realOrt } from './fixtures/realOrt';
import { testFfmpeg, writeMarkerVideo } from './fixtures/walkVideo';
import { decodeFrame, videoSize } from './frames';
import { registerInferenceIpc, type InferenceEnv } from './index';
import { createInferenceHost, type ChildLike } from './utility';
import { createWorkerCore, type FromWorker } from './worker';

const ort = realOrt();

function host() {
  const core = createWorkerCore(() => Promise.resolve(ort));
  return createInferenceHost((): ChildLike => {
    let onMessage: (m: FromWorker) => void = () => undefined;
    return {
      postMessage: (m) => {
        void core.handle(m).then((r) => {
          onMessage(r);
        });
      },
      onMessage: (fn) => {
        onMessage = fn;
      },
      onExit: () => undefined,
      kill: () => undefined,
    };
  });
}

const PHOTOS: Record<string, MarkerPatch[]> = {
  p1: [{ cls: 'marker', box: [40, 50, 72, 82] }],
  p2: [
    { cls: 'marker', box: [200, 40, 232, 72] },
    { cls: 'cyan-marker', box: [60, 200, 92, 240] },
  ],
  p3: [],
};

/** The synthetic walk's playback copy: equirectangular, 2:1. */
const WALK_W = 640;
const WALK_H = 320;

let base: string;
let root: string;
let events: IpcEvent<'inference:progress'>[];
let env: InferenceEnv;
let decoded: string[];
let frames: number[];
let walkJson: boolean;
let hook: ((e: IpcEvent<'inference:progress'>) => void) | null = null;

const manifest = {
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      items: Object.keys(PHOTOS).map((id) => ({ id, src: { path: `photos/${id}.png` } })),
    },
    // a later date: the same photo ids in another layer
    {
      kind: 'photos',
      id: 'later',
      name: 'Later photos',
      items: ['p1', 'p2'].map((id) => ({ id, src: { path: `later/${id}.png` } })),
    },
    { kind: 'video', id: 'clip', name: 'Clip', src: { path: 'video/clip.mp4' } },
    // a 360 walk: its playback copy is made by the walk tests below
    {
      kind: 'walk',
      id: 'walk-w1',
      name: 'Walk 1',
      record: { path: 'walks/w1/walk.json' },
      src: { path: 'walks/w1/playback.mp4' },
      durationS: 3,
    },
  ],
} as unknown as ProjectManifest;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-infer-'));
  root = join(base, 'project');
  await mkdir(join(root, 'detections'), { recursive: true });
  events = [];
  decoded = [];
  frames = [];
  walkJson = true;
  const h = host();
  env = {
    dirs: () => Promise.resolve({ user: join(base, 'models'), pack: null }),
    settings: () => ({ provider: 'cpu' }),
    host: () => h,
    project: (projectId) =>
      Promise.resolve(
        projectId === 'pkg'
          ? { error: 'This project is a read-only package. Detections are not saved into it.' }
          : { root, manifest },
      ),
    decode: async (_root, rel) => {
      const id = rel.replace(/^(photos|later)\/|\.png$/g, '');
      decoded.push(id);
      // decoding takes a moment, as it does in the app
      await new Promise((r) => setTimeout(r, 20));
      const rgba = markerPhotoRgba(320, 320, PHOTOS[id] ?? []);
      return { width: 320, height: 320, scaledWidth: 320, scaledHeight: 320, rgba };
    },
    decodeFrame: (r, rel, t, width, height) => {
      frames.push(t);
      return decodeFrame({ ffmpeg: testFfmpeg ?? 'ffmpeg', file: join(r, rel), t, width, height });
    },
    videoSize: (r, rel) => videoSize(testFfmpeg ?? 'ffmpeg', join(r, rel)),
    // the walk.json fields a run reads (the walk tests write no full walk.json)
    readWalk: () =>
      Promise.resolve(
        walkJson ? ({ video: { width: WALK_W, height: WALK_H } } as unknown as WalkFile) : null,
      ),
    readPass: async (r, name) => {
      try {
        return DetectionsFile.parse(
          JSON.parse(await readFile(join(r, 'detections', name), 'utf8')),
        );
      } catch {
        return null;
      }
    },
    writePass: async (r, name, file) => {
      await writeFile(join(r, 'detections', name), JSON.stringify(DetectionsFile.parse(file)));
      return { ok: true };
    },
    progress: (e) => {
      events.push(e);
      hook?.(e);
    },
    now: () => '2026-10-06T10:00:00.000Z',
  };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function modelSource(opts: { wrongLayout?: boolean; corrupt?: boolean } = {}) {
  const dir = join(base, 'src', opts.wrongLayout ? 'wrong' : opts.corrupt ? 'corrupt' : 'good');
  await mkdir(dir, { recursive: true });
  const onnx = opts.corrupt
    ? new TextEncoder().encode('this is not an onnx model at all')
    : markerDetectorOnnx({ wrongLayout: opts.wrongLayout ?? false });
  await writeFile(join(dir, 'model.onnx'), onnx);
  await writeFile(join(dir, 'model.json'), JSON.stringify(markerCard(onnx)));
  return dir;
}

const ipcOf = () =>
  collectHandlers((handle) => {
    registerInferenceIpc({ handle, env });
  });

describe('inference IPC', () => {
  it('registers every inference channel', () => {
    expect(ipcOf().channels()).toEqual([
      'inference:cancel',
      'inference:importModel',
      'inference:models',
      'inference:removeModel',
      'inference:run',
    ]);
  });

  it.skipIf(!ort)('reports the runtime and the installed models', async () => {
    const r = await ipcOf().call('inference:models', {});
    expect(r.runtime).toMatchObject({ available: true, provider: 'cpu' });
    expect(r.runtime.version).toMatch(/^\d+\.\d+/);
    expect(r.runtime.backends).toContain('cpu');
    expect(r.models).toEqual([]);
  });
});

describe.skipIf(!ort)('import with onnxruntime', () => {
  it('imports the test detector and shows its card', async () => {
    const ipc = ipcOf();
    const r = await ipc.call('inference:importModel', {
      path: await modelSource(),
      acceptLicence: true,
    });
    expect(r).toMatchObject({
      ok: true,
      model: { id: 'marker-test-detector-1.0.0', card: { licence: 'MIT' } },
    });
    expect((await ipc.call('inference:models', {})).models.map((m) => m.id)).toEqual([
      'marker-test-detector-1.0.0',
    ]);
    expect(await ipc.call('inference:removeModel', { id: 'marker-test-detector-1.0.0' })).toEqual({
      ok: true,
    });
  });

  it('refuses a corrupt file and a wrong layout with the exact reason', async () => {
    const ipc = ipcOf();
    const corrupt = await ipc.call('inference:importModel', {
      path: await modelSource({ corrupt: true }),
      acceptLicence: true,
    });
    expect(corrupt).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^The model could not be loaded: /) as string,
    });
    const wrong = await ipc.call('inference:importModel', {
      path: await modelSource({ wrongLayout: true }),
      acceptLicence: true,
    });
    expect(wrong).toEqual({
      ok: false,
      error:
        'The model card says yolo-v8, which gives one output [1, 6, N] (4 box values and 2 class scores per row), but this model gives [1, 600].',
    });
  });
});

describe.skipIf(!ort)('runs', () => {
  const items = Object.keys(PHOTOS).map((photo) => ({ layer: 'photos', photo }));
  async function installed() {
    const ipc = ipcOf();
    await ipc.call('inference:importModel', { path: await modelSource(), acceptLicence: true });
    return ipc;
  }
  const pass = async (name: string) =>
    DetectionsFile.parse(JSON.parse(await readFile(join(root, 'detections', name), 'utf8')));

  it('writes draft model detections with mapped classes, and reports progress', async () => {
    const ipc = await installed();
    const r = await ipc.call('inference:run', {
      runId: 'r1',
      projectId: 'p',
      model: 'marker-test-detector-1.0.0',
      items,
      classMap: { marker: 'paint' },
      minConfidence: 0.5,
    });
    expect(r).toEqual({ ok: true, file: 'detections/model-r1.json', count: 3 });
    const file = await pass('model-r1.json');
    expect(file).toMatchObject({
      source: 'model',
      producer: 'Marker test detector 1.0.0',
      layer: 'photos',
      assessed: ['p1', 'p2', 'p3'],
      run: { id: 'r1', model: 'marker-test-detector-1.0.0', images: 3, detections: 3, costUsd: 0 },
    });
    expect(
      file.detections.map((d) => [d.photo, d.class, d.label, d.status, d.bbox.map(Math.round)]),
    ).toEqual([
      ['p1', 'paint', undefined, 'draft', [40, 50, 72, 82]],
      // best first on each photo
      ['p2', 'cyan-marker', 'cyan-marker', 'draft', [60, 200, 92, 240]],
      ['p2', 'paint', undefined, 'draft', [200, 40, 232, 72]],
    ]);
    expect(file.detections[0]?.origin).toEqual({
      model: 'marker-test-detector-1.0.0',
      runId: 'r1',
    });
    expect(events.at(-1)).toEqual({ runId: 'r1', done: 3, total: 3, found: 3 });
  });

  it('cancel keeps the photos done; the same run id resumes with the rest', async () => {
    const ipc = await installed();
    const req = {
      runId: 'r2',
      projectId: 'p',
      model: 'marker-test-detector-1.0.0',
      items,
      classMap: {},
      minConfidence: 0.5,
    };
    // stop as soon as the first photo is done
    hook = (e) => {
      if (e.done === 1) void ipc.call('inference:cancel', { runId: 'r2' });
    };
    expect(await ipc.call('inference:run', req)).toEqual({
      ok: true,
      file: 'detections/model-r2.json',
      count: 1,
    });
    expect((await pass('model-r2.json')).assessed).toEqual(['p1']);
    hook = null;
    decoded.length = 0;
    expect(await ipc.call('inference:run', req)).toEqual({
      ok: true,
      file: 'detections/model-r2.json',
      count: 3,
    });
    expect(decoded).toEqual(['p2', 'p3']);
    expect((await pass('model-r2.json')).assessed).toEqual(['p1', 'p2', 'p3']);
  });

  it('a run over two layers with the same photo ids writes one pass per layer', async () => {
    const ipc = await installed();
    const req = {
      runId: 'r4',
      projectId: 'p',
      model: 'marker-test-detector-1.0.0',
      items: [...items, { layer: 'later', photo: 'p1' }, { layer: 'later', photo: 'p2' }],
      classMap: {},
      minConfidence: 0.5,
    };
    // stop after the first photo of the later layer: its p1 is not the earlier p1
    hook = (e) => {
      if (e.done === 4) void ipc.call('inference:cancel', { runId: 'r4' });
    };
    expect(await ipc.call('inference:run', req)).toEqual({
      ok: true,
      file: 'detections/model-r4-photos.json',
      count: 4,
    });
    hook = null;
    decoded.length = 0;
    expect(await ipc.call('inference:run', req)).toEqual({
      ok: true,
      file: 'detections/model-r4-photos.json',
      count: 6,
    });
    expect(decoded).toEqual(['p2']);
    const earlier = await pass('model-r4-photos.json');
    const later = await pass('model-r4-later.json');
    expect(earlier).toMatchObject({ layer: 'photos', assessed: ['p1', 'p2', 'p3'] });
    expect(later).toMatchObject({ layer: 'later', assessed: ['p1', 'p2'], run: { id: 'r4' } });
    expect(earlier.detections).toHaveLength(3);
    expect(later.detections.map((d) => d.photo)).toEqual(['p1', 'p2', 'p2']);
    expect(events.at(-1)).toEqual({ runId: 'r4', done: 5, total: 5, found: 6 });
  });

  it('refuses ordinary video frames, packages, unknown models, layers and photos', async () => {
    const ipc = await installed();
    const base = {
      runId: 'r3',
      projectId: 'p',
      model: 'marker-test-detector-1.0.0',
      classMap: {},
      minConfidence: 0.5,
    };
    expect(await ipc.call('inference:run', { ...base, items: [{ layer: 'clip', t: 3 }] })).toEqual({
      ok: false,
      error:
        'Local detection on ordinary video clips is not supported yet: pick photos or a 360 walk.',
    });
    expect(await ipc.call('inference:run', { ...base, items: [{ layer: 'nope', t: 3 }] })).toEqual({
      ok: false,
      error: 'There is no 360 walk layer "nope" in this project.',
    });
    expect(
      await ipc.call('inference:run', { ...base, items: [{ layer: 'walk-w1', t: 9 }] }),
    ).toEqual({ ok: false, error: 'Walk 1 lasts 3 s: there is no frame at 9 s.' });
    expect(await ipc.call('inference:run', { ...base, projectId: 'pkg', items })).toMatchObject({
      ok: false,
      error: expect.stringContaining('read-only package') as string,
    });
    expect(await ipc.call('inference:run', { ...base, model: 'nope', items })).toEqual({
      ok: false,
      error: 'There is no detector model "nope". Import it in Settings, Detection models.',
    });
    expect(
      await ipc.call('inference:run', { ...base, items: [{ layer: 'photos', photo: 'p9' }] }),
    ).toEqual({ ok: false, error: 'There is no photo "p9" in Photos.' });
  });
});

describe.skipIf(!ort || !testFfmpeg)('runs on 360 walk frames', { timeout: 60_000 }, () => {
  /**
   * Second 0: a magenta marker cut by the seam and a cyan one; 1: nothing; 2: a magenta one. The
   * test detector sees patches up to 64 input pixels whole, so they stay small for the tiled run.
   */
  const SECONDS: MarkerPatch[][] = [
    [
      { cls: 'marker', box: [608, 120, 640, 160] },
      { cls: 'marker', box: [0, 120, 24, 160] },
      { cls: 'cyan-marker', box: [200, 100, 240, 140] },
    ],
    [],
    [{ cls: 'marker', box: [300, 140, 340, 180] }],
  ];
  const items = [0.5, 1.5, 2.5].map((t) => ({ layer: 'walk-w1', t }));
  const req = (runId: string, over: object = {}) => ({
    runId,
    projectId: 'p',
    model: 'marker-test-detector-1.0.0',
    items,
    classMap: { marker: 'paint' },
    minConfidence: 0.5,
    ...over,
  });
  async function installed() {
    await writeMarkerVideo(
      testFfmpeg ?? 'ffmpeg',
      join(root, 'walks', 'w1', 'playback.mp4'),
      WALK_W,
      WALK_H,
      SECONDS,
    );
    const ipc = ipcOf();
    await ipc.call('inference:importModel', { path: await modelSource(), acceptLicence: true });
    return ipc;
  }
  const pass = async (name: string) =>
    DetectionsFile.parse(JSON.parse(await readFile(join(root, 'detections', name), 'utf8')));
  /** Within 4 px: the frame went through H.264 and a scale-down. */
  const near = (got: readonly number[], want: readonly number[]) =>
    got.every((v, i) => Math.abs(v - (want[i] ?? 0)) <= 4);
  const expectFrameDrafts = (file: DetectionsFile) => {
    // by time, then left to right (the score order differs with the decode size)
    const dets = [...file.detections].sort(
      (p, q) => (p.frame?.t ?? 0) - (q.frame?.t ?? 0) || p.bbox[0] - q.bbox[0],
    );
    expect(dets.map((d) => [d.frame?.t, d.class, d.label])).toEqual([
      [0.5, 'cyan-marker', 'cyan-marker'],
      // the two halves at the seam are one box that wraps: x1 past the width
      [0.5, 'paint', undefined],
      [2.5, 'paint', undefined],
    ]);
    const boxes = dets.map((d) => d.bbox);
    expect(near(boxes[0] ?? [], [200, 100, 240, 140])).toBe(true);
    expect(near(boxes[1] ?? [], [608, 120, 664, 160])).toBe(true);
    expect(near(boxes[2] ?? [], [300, 140, 340, 180])).toBe(true);
    for (const d of dets) {
      expect(d).toMatchObject({
        frame: { layer: 'walk-w1' },
        space: 'source',
        width: WALK_W,
        height: WALK_H,
        status: 'draft',
        source: 'model',
        origin: { model: 'marker-test-detector-1.0.0' },
      });
      expect(d.photo).toBeUndefined();
    }
  };

  it('writes frame drafts in source pixels and merges a marker across the seam', async () => {
    const ipc = await installed();
    const r = await ipc.call('inference:run', req('w1'));
    expect(r).toEqual({ ok: true, file: 'detections/model-w1.json', count: 3 });
    const file = await pass('model-w1.json');
    expect(file).toMatchObject({
      source: 'model',
      layer: 'walk-w1',
      assessed: ['t:500', 't:1500', 't:2500'],
      run: { id: 'w1', images: 3, detections: 3 },
    });
    expectFrameDrafts(file);
    // the model input is 320 square: the 640 x 320 frame is decoded at 320 x 160
    expect(frames).toEqual([0.5, 1.5, 2.5]);
    expect(new Set(file.detections.map((d) => d.id)).size).toBe(3);
    expect(events.at(-1)).toEqual({ runId: 'w1', done: 3, total: 3, found: 3 });
    expect(events.map((e) => e.current).filter(Boolean)).toEqual(['t:500', 't:1500', 't:2500']);
  });

  it('runs wrapping tiles on a full-size frame with the same result', async () => {
    const ipc = await installed();
    const r = await ipc.call('inference:run', req('w2', { tile: { size: 320, overlap: 64 } }));
    expect(r).toMatchObject({ ok: true, count: 3 });
    expectFrameDrafts(await pass('model-w2.json'));
  });

  it('reads the frame size from the video when walk.json is unreadable', async () => {
    walkJson = false;
    const ipc = await installed();
    expect(await ipc.call('inference:run', req('w3'))).toMatchObject({ ok: true, count: 3 });
    expectFrameDrafts(await pass('model-w3.json'));
  });

  it('cancel keeps the frames done; the same run id resumes with the rest', async () => {
    const ipc = await installed();
    hook = (e) => {
      if (e.done === 1) void ipc.call('inference:cancel', { runId: 'w4' });
    };
    expect(await ipc.call('inference:run', req('w4'))).toMatchObject({ ok: true, count: 2 });
    expect((await pass('model-w4.json')).assessed).toEqual(['t:500']);
    hook = null;
    frames.length = 0;
    expect(await ipc.call('inference:run', req('w4'))).toMatchObject({ ok: true, count: 3 });
    expect(frames).toEqual([1.5, 2.5]);
    expectFrameDrafts(await pass('model-w4.json'));
  });

  it('a run over photos and a walk writes a pass for each', async () => {
    const ipc = await installed();
    const r = await ipc.call(
      'inference:run',
      req('w5', { items: [{ layer: 'photos', photo: 'p1' }, ...items] }),
    );
    expect(r).toEqual({ ok: true, file: 'detections/model-w5-photos.json', count: 4 });
    expect((await pass('model-w5-photos.json')).detections.map((d) => d.space)).toEqual([
      'preview',
    ]);
    expectFrameDrafts(await pass('model-w5-walk-w1.json'));
  });
});
