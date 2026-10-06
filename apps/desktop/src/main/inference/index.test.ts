import { DetectionsFile, type IpcEvent, type ProjectManifest } from '@aio/schema';
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

let base: string;
let root: string;
let events: IpcEvent<'inference:progress'>[];
let env: InferenceEnv;
let decoded: string[];
let hook: ((e: IpcEvent<'inference:progress'>) => void) | null = null;

const manifest = {
  layers: [
    {
      kind: 'photos',
      id: 'photos',
      name: 'Photos',
      items: Object.keys(PHOTOS).map((id) => ({ id, src: { path: `photos/${id}.png` } })),
    },
  ],
} as unknown as ProjectManifest;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'aio-infer-'));
  root = join(base, 'project');
  await mkdir(join(root, 'detections'), { recursive: true });
  events = [];
  decoded = [];
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
      const id = rel.replace(/^photos\/|\.png$/g, '');
      decoded.push(id);
      // decoding takes a moment, as it does in the app
      await new Promise((r) => setTimeout(r, 20));
      const rgba = markerPhotoRgba(320, 320, PHOTOS[id] ?? []);
      return { width: 320, height: 320, scaledWidth: 320, scaledHeight: 320, rgba };
    },
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

  it('refuses video frames, packages, unknown models and photos', async () => {
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
      error: 'Local detection works on photos. Video frames are not supported yet: pick photos.',
    });
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
